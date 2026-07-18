const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return hex(new Uint8Array(digest));
}

export async function signSession(claims, secret, now = Math.floor(Date.now() / 1000)) {
  requireSecret(secret, 'SESSION_SIGNING_KEY');
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        ...claims,
        iat: now,
        exp: claims.exp ?? now + 60 * 60 * 24 * 7,
      }),
    ),
  );
  const body = `${header}.${payload}`;
  return `${body}.${await hmacBase64url(body, secret)}`;
}

export async function verifySession(token, secret, now = Math.floor(Date.now() / 1000)) {
  requireSecret(secret, 'SESSION_SIGNING_KEY');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid session');
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) throw new Error('invalid session');
  const expected = await hmacBase64url(`${header}.${payload}`, secret);
  if (!constantTimeEqual(signature, expected)) throw new Error('invalid session');
  const decodedHeader = JSON.parse(decoder.decode(fromBase64url(header)));
  if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') {
    throw new Error('invalid session');
  }
  const claims = JSON.parse(decoder.decode(fromBase64url(payload)));
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.exp !== 'number' ||
    claims.exp <= now ||
    (typeof claims.iat === 'number' && claims.iat > now + 60)
  ) {
    throw new Error('expired or invalid session');
  }
  return claims;
}

export async function verifyStripeSignature(payload, signatureHeader, secret, now = Date.now()) {
  requireSecret(secret, 'STRIPE_WEBHOOK_SECRET');
  const fields = String(signatureHeader || '')
    .split(',')
    .map((part) => part.trim().split('=', 2));
  const timestamp = Number(fields.find(([key]) => key === 't')?.[1]);
  const signatures = fields.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > 300) return false;
  const expected = await hmacHex(`${timestamp}.${payload}`, secret);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

export function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

async function hmacBase64url(value, secret) {
  const signature = await hmac(value, secret);
  return base64url(signature);
}

async function hmacHex(value, secret) {
  return hex(await hmac(value, secret));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireSecret(secret, name) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
}
