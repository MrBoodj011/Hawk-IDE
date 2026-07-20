import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { domainToASCII } from 'node:url';

const token = requiredEnvironment('HAWK_PROXY_TOKEN');
const listenPort = optionalPort('HAWK_PROXY_PORT', 3128);
const allowedHosts = parseAllowedHosts(requiredEnvironment('HAWK_ALLOWED_HOSTS'));
const allowedPorts = new Set(
  requiredEnvironment('HAWK_ALLOWED_PORTS')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65_535),
);
if (allowedPorts.size === 0) throw new Error('HAWK_ALLOWED_PORTS has no valid ports');
const allowedMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

const server = http.createServer((request, response) => {
  void handleHttp(request, response);
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 128;
server.maxRequestsPerSocket = 100;
server.on('connect', (request, client, head) => {
  void handleConnect(request, client, head);
});
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.listen(listenPort, '0.0.0.0', () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({
      event: 'hawk-egress-ready',
      port: typeof address === 'object' && address ? address.port : listenPort,
      allowlistDigest: createHash('sha256')
        .update([...allowedHosts, ...allowedPorts].join('\u0000'))
        .digest('hex'),
    })}\n`,
  );
});

async function handleConnect(request, client, head) {
  if (!authorized(request)) {
    rejectSocket(client, 407, 'Proxy Authentication Required');
    return;
  }
  const destination = parseAuthority(request.url ?? '', 443);
  if (!destination || !destinationAllowed(destination.host, destination.port)) {
    rejectSocket(client, 403, 'Forbidden');
    return;
  }
  const upstream = net.connect({ host: destination.host, port: destination.port });
  upstream.setTimeout(30_000);
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.once('error', () => rejectSocket(client, 502, 'Bad Gateway'));
  client.once('error', () => upstream.destroy());
}

async function handleHttp(request, response) {
  if (!authorized(request)) {
    response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Hawk"' });
    response.end('Proxy authentication required');
    return;
  }
  if (!allowedMethods.has(String(request.method ?? '').toUpperCase())) {
    response.writeHead(405, { Allow: [...allowedMethods].join(', ') });
    response.end('HTTP method is outside the Hawk egress policy');
    return;
  }
  let target;
  try {
    target = new URL(request.url ?? '');
  } catch {
    response.writeHead(400);
    response.end('Absolute HTTP proxy URL required');
    return;
  }
  if (target.protocol !== 'http:' || target.username || target.password) {
    response.writeHead(403);
    response.end('Only credential-free absolute HTTP URLs are accepted; use CONNECT for HTTPS');
    return;
  }
  const port = target.port ? Number.parseInt(target.port, 10) : 80;
  if (!destinationAllowed(target.hostname, port)) {
    response.writeHead(403);
    response.end('Destination is outside the Hawk egress allowlist');
    return;
  }
  const headers = { ...request.headers, host: target.host, connection: 'close' };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = http.request(
    {
      hostname: target.hostname,
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: 30_000,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end('Hawk egress proxy could not reach the approved destination');
  });
  request.pipe(upstream);
}

function authorized(request) {
  const header = String(request.headers['proxy-authorization'] ?? '');
  if (!header.startsWith('Basic ')) return false;
  let value = '';
  try {
    value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = value.indexOf(':');
  const supplied = separator >= 0 ? value.slice(separator + 1) : '';
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function destinationAllowed(rawHost, port) {
  const host = normalizeHost(rawHost);
  if (!host || !allowedPorts.has(port)) return false;
  return allowedHosts.some((allowed) =>
    allowed.startsWith('*.')
      ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2)
      : host === allowed,
  );
}

function parseAllowedHosts(value) {
  const output = [];
  for (const item of value.split(',')) {
    const candidate = item.trim().toLowerCase();
    const wildcard = candidate.startsWith('*.');
    const normalized = normalizeHost(wildcard ? candidate.slice(2) : candidate);
    if (!normalized) throw new Error(`Invalid allowed host: ${item}`);
    output.push(wildcard ? `*.${normalized}` : normalized);
  }
  return [...new Set(output)];
}

function normalizeHost(value) {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (net.isIP(unwrapped)) return unwrapped.toLowerCase();
  const ascii = domainToASCII(unwrapped.replace(/\.$/, '').toLowerCase());
  if (
    !ascii ||
    ascii.length > 253 ||
    !ascii.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return '';
  }
  return ascii;
}

function parseAuthority(value, defaultPort) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    return { host: bracketed[1] ?? '', port: Number(bracketed[2] ?? defaultPort) };
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || value.indexOf(':') !== separator) {
    return { host: value, port: defaultPort };
  }
  return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) };
}

function rejectSocket(socket, status, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  }
}

function requiredEnvironment(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPort(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}
