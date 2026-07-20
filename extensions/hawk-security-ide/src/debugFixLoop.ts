import type { AiSessionSummary } from './types';

export interface DebugFixLoopDriver {
  getSession(sessionId: string): Promise<AiSessionSummary>;
  runTests(sessionId: string, gateIds: string[]): Promise<AiSessionSummary>;
  continueSession(sessionId: string, prompt: string, context: string): Promise<AiSessionSummary>;
}

export interface DebugFixLoopProgress {
  attempt: number;
  maxAttempts: number;
  phase: 'waiting' | 'testing' | 'retrying' | 'passed' | 'exhausted';
  session: AiSessionSummary;
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
  ) => Promise<{ prompt: string; context: string }>;
  onProgress?: (progress: DebugFixLoopProgress) => void | Promise<void>;
}

export interface DebugFixLoopResult {
  outcome: 'passed' | 'exhausted' | 'cancelled' | 'no-gates';
  attempts: number;
  session: AiSessionSummary;
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
      if (allGatesPassed(session)) {
        await options.onProgress?.({
          attempt,
          maxAttempts,
          phase: 'passed',
          session,
        });
        return { outcome: 'passed', attempts: attempt, session };
      }
    }

    if (attempt === maxAttempts) {
      await options.onProgress?.({
        attempt,
        maxAttempts,
        phase: 'exhausted',
        session,
      });
      return { outcome: 'exhausted', attempts: attempt, session };
    }

    await options.onProgress?.({
      attempt,
      maxAttempts,
      phase: 'retrying',
      session,
    });
    const retry = await options.buildRetry(session, attempt);
    throwIfAborted(options.signal);
    session = await options.driver.continueSession(session.id, retry.prompt, retry.context);
  }

  return { outcome: 'exhausted', attempts: maxAttempts, session };
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
