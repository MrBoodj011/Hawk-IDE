import type { AiSessionSummary } from './types';

export interface DebugFixLoopDriver {
  getSession(sessionId: string): Promise<AiSessionSummary>;
  runTests(sessionId: string, gateIds: string[]): Promise<AiSessionSummary>;
  continueSession(sessionId: string, prompt: string, context: string): Promise<AiSessionSummary>;
  /** Relaunch the debugger using the preserved launch configuration. */
  relaunchDebugger?(sessionId: string, attempt: number): Promise<void>;
  /** Re-run the original failure after a relaunch and return bounded evidence. */
  reproduceFailure?(sessionId: string, attempt: number): Promise<DebugReproductionResult>;
}

export interface DebugReproductionResult {
  status: 'reproduced' | 'not-reproduced' | 'failed';
  output: string;
}

export interface DebugFixLoopProgress {
  attempt: number;
  maxAttempts: number;
  phase:
    | 'waiting'
    | 'relaunching'
    | 'reproducing'
    | 'testing'
    | 'retrying'
    | 'passed'
    | 'exhausted';
  session: AiSessionSummary;
  reproduction?: DebugReproductionResult;
}

export interface DebugFixLoopOptions {
  session: AiSessionSummary;
  maxAttempts: number;
  pollIntervalMs?: number;
  attemptTimeoutMs?: number;
  signal?: AbortSignal;
  driver: DebugFixLoopDriver;
  buildRetry: (
    session: AiSessionSummary,
    attempt: number,
    reproduction?: DebugReproductionResult,
  ) => Promise<{ prompt: string; context: string }>;
  onProgress?: (progress: DebugFixLoopProgress) => void | Promise<void>;
}

export interface DebugFixLoopResult {
  outcome: 'passed' | 'exhausted' | 'cancelled' | 'no-gates';
  attempts: number;
  session: AiSessionSummary;
  reproduction?: DebugReproductionResult;
}

/**
 * Bounded test/debug/fix coordinator. It never applies a patch: every edit
 * remains inside the durable Hawk worktree until the operator reviews it.
 */
export async function runAutomaticDebugFixLoop(
  options: DebugFixLoopOptions,
): Promise<DebugFixLoopResult> {
  const maxAttempts = Math.max(1, Math.min(6, Math.floor(options.maxAttempts)));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 500);
  const attemptTimeoutMs = Math.max(5_000, options.attemptTimeoutMs ?? 30 * 60_000);
  let session = options.session;
  if (session.testGates.length === 0) {
    return { outcome: 'no-gates', attempts: 0, session };
  }

  let reproduction: DebugReproductionResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    session = await waitUntilReview(
      options.driver,
      session,
      pollIntervalMs,
      attemptTimeoutMs,
      options.signal,
      async (current) => {
        await options.onProgress?.({
          attempt,
          maxAttempts,
          phase: 'waiting',
          session: current,
        });
      },
    );
    throwIfAborted(options.signal);

    // A debugger relaunch is deliberately performed before every verification
    // attempt. This catches fixes that make the static test suite green while
    // the original runtime failure is still reproducible.
    if (options.driver.relaunchDebugger) {
      await options.onProgress?.({
        attempt,
        maxAttempts,
        phase: 'relaunching',
        session,
      });
      await options.driver.relaunchDebugger(session.id, attempt);
      throwIfAborted(options.signal);
    }
    if (options.driver.reproduceFailure) {
      await options.onProgress?.({
        attempt,
        maxAttempts,
        phase: 'reproducing',
        session,
      });
      reproduction = await options.driver.reproduceFailure(session.id, attempt);
      throwIfAborted(options.signal);
    }

    if (session.status === 'awaiting-review') {
      await options.onProgress?.({
        attempt,
        maxAttempts,
        phase: 'testing',
        session,
      });
      session = await options.driver.runTests(
        session.id,
        session.testGates.map((gate) => gate.id),
      );
      throwIfAborted(options.signal);
      if (allGatesPassed(session) && (!reproduction || reproduction.status === 'not-reproduced')) {
        await options.onProgress?.({
          attempt,
          maxAttempts,
          phase: 'passed',
          session,
          reproduction,
        });
        return { outcome: 'passed', attempts: attempt, session, reproduction };
      }
    }

    if (attempt === maxAttempts) {
      await options.onProgress?.({
        attempt,
        maxAttempts,
        phase: 'exhausted',
        session,
        reproduction,
      });
      return { outcome: 'exhausted', attempts: attempt, session, reproduction };
    }

    await options.onProgress?.({
      attempt,
      maxAttempts,
      phase: 'retrying',
      session,
      reproduction,
    });
    const retry = await options.buildRetry(session, attempt, reproduction);
    throwIfAborted(options.signal);
    session = await options.driver.continueSession(session.id, retry.prompt, retry.context);
  }

  return { outcome: 'exhausted', attempts: maxAttempts, session, reproduction };
}

async function waitUntilReview(
  driver: DebugFixLoopDriver,
  initial: AiSessionSummary,
  pollIntervalMs: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onPoll: (session: AiSessionSummary) => Promise<void>,
): Promise<AiSessionSummary> {
  const deadline = Date.now() + timeoutMs;
  let session = initial;
  while (
    session.status === 'preparing' ||
    session.status === 'running' ||
    session.status === 'testing'
  ) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      throw new Error('The automatic debug attempt timed out. Its isolated worktree is preserved.');
    }
    await onPoll(session);
    await abortableDelay(pollIntervalMs, signal);
    session = await driver.getSession(session.id);
  }
  if (session.status === 'paused' || session.status === 'cancelled') {
    throw new Error(`The automatic debug loop stopped because the Hawk task is ${session.status}.`);
  }
  if (session.status !== 'awaiting-review' && session.status !== 'failed') {
    throw new Error(`The automatic debug loop cannot continue from ${session.status}.`);
  }
  return session;
}

function allGatesPassed(session: AiSessionSummary): boolean {
  return session.testGates.every((gate) =>
    session.testResults.some((result) => result.gateId === gate.id && result.status === 'passed'),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    function finish(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('Hawk automatic debug loop stopped by the operator.');
  error.name = 'AbortError';
  return error;
}
