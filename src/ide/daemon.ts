import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  type DaemonHealth,
  IDE_PROTOCOL_VERSION,
  type RetestResult,
  type SecurityFinding,
  type TrafficInventory,
  type WorkspaceInventory,
} from './protocol.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';
import { importHarTraffic } from './traffic.js';

const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

export interface IdeDaemonOptions {
  workspaceRoot?: string;
  host?: string;
  port?: number;
  token?: string;
  now?: () => Date;
}

export interface IdeDaemonHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
  inventory(): WorkspaceInventory | null;
}

/**
 * Local control plane for the future Code-OSS client. It binds to loopback
 * only, protects every endpoint with a process-scoped token, and keeps the
 * initial surface deliberately small while the desktop UI is built.
 */
export async function startIdeDaemon(opts: IdeDaemonOptions = {}): Promise<IdeDaemonHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new Error('IDE daemon may only bind to a loopback host');
  const workspaceRoot = resolve(opts.workspaceRoot ?? process.cwd());
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const now = opts.now ?? (() => new Date());
  let latestInventory: WorkspaceInventory | null = null;
  let findings: SecurityFinding[] = [];
  let traffic: TrafficInventory | null = null;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      token,
      workspaceRoot,
      now,
      inventory: () => latestInventory,
      setInventory: (value) => {
        latestInventory = value;
      },
      findings: () => findings,
      setFindings: (value) => {
        findings = value;
      },
      traffic: () => traffic,
      setTraffic: (value) => {
        traffic = value;
      },
    });
  });

  return await new Promise<IdeDaemonHandle>((resolveHandle, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : (opts.port ?? 0);
      const url = `http://${host}:${port}`;
      resolveHandle({
        host,
        port,
        url,
        token,
        inventory: () => latestInventory,
        close: () => closeServer(server),
      });
    });
  });
}

interface RequestContext {
  token: string;
  workspaceRoot: string;
  now: () => Date;
  inventory: () => WorkspaceInventory | null;
  setInventory(value: WorkspaceInventory): void;
  findings(): SecurityFinding[];
  setFindings(value: SecurityFinding[]): void;
  traffic(): TrafficInventory | null;
  setTraffic(value: TrafficInventory): void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (!validLoopbackHost(req)) {
    sendJSON(res, 403, { ok: false, error: 'invalid host' });
    return;
  }
  if (!authorized(req, context.token)) {
    sendJSON(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const requestURL = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = requestURL.pathname;

  if (req.method === 'GET' && pathname === '/v1/health') {
    const health: DaemonHealth = {
      ok: true,
      protocolVersion: IDE_PROTOCOL_VERSION,
      workspaceRoot: context.workspaceRoot,
    };
    sendJSON(res, 200, health);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/workspace/index') {
    try {
      await consumeBody(req);
      const scan = await scanWorkspaceRoutes(context.workspaceRoot);
      const inventory: WorkspaceInventory = {
        protocolVersion: IDE_PROTOCOL_VERSION,
        root: context.workspaceRoot,
        indexedAt: context.now().toISOString(),
        sourceFiles: scan.sourceFiles,
        routes: scan.routes,
      };
      context.setInventory(inventory);
      sendJSON(res, 200, inventory);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/workspace/inventory') {
    const inventory = context.inventory();
    if (!inventory) {
      sendJSON(res, 404, { ok: false, error: 'workspace has not been indexed yet' });
      return;
    }
    sendJSON(res, 200, inventory);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/findings') {
    sendJSON(res, 200, { findings: context.findings() });
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/traffic') {
    const traffic = context.traffic();
    if (!traffic) {
      sendJSON(res, 404, { ok: false, error: 'no traffic has been imported yet' });
      return;
    }
    sendJSON(res, 200, traffic);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/traffic/import/har') {
    try {
      const body = await readBody(req);
      const traffic = importHarTraffic(JSON.parse(body.toString('utf8')), context.now());
      context.setTraffic(traffic);
      sendJSON(res, 200, traffic);
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/audit/static') {
    try {
      await consumeBody(req);
      const audit = await scanWorkspaceSecurity(context.workspaceRoot, context.now());
      context.setFindings(audit.findings);
      sendJSON(res, 200, audit);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  const retestMatch = pathname.match(/^\/v1\/findings\/([^/]+)\/retest$/);
  if (req.method === 'POST' && retestMatch?.[1]) {
    try {
      await consumeBody(req);
      const id = decodeURIComponent(retestMatch[1]);
      const previous = context.findings().find((finding) => finding.id === id);
      if (!previous) {
        sendJSON(res, 404, { ok: false, error: 'finding not found' });
        return;
      }
      const audit = await scanWorkspaceSecurity(context.workspaceRoot, context.now());
      context.setFindings(audit.findings);
      const current = audit.findings.find((finding) => finding.id === id);
      const result: RetestResult = current
        ? { finding: current, present: true }
        : { finding: { ...previous, status: 'fixed' }, present: false };
      sendJSON(res, 200, result);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: errorMessage(err) });
    }
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'not found' });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const rawHeader = req.headers['x-pentesterflow-token'];
  const supplied = Array.isArray(rawHeader) ? (rawHeader[0] ?? '') : (rawHeader ?? '');
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function validLoopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true;
  const host = raw
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return isLoopbackHost(host);
}

function consumeBody(req: IncomingMessage): Promise<void> {
  return readBody(req).then(() => undefined);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
