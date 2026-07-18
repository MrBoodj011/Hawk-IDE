import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  constantTimeEqual,
  sha256,
  signSession,
  verifySession,
  verifyStripeSignature,
} from './lib/crypto.mjs';
import { entitlements, hasRole, stripePriceFor } from './lib/plans.mjs';

const secret = 'test-secret-that-is-longer-than-thirty-two-characters';

describe('control-plane cryptography', () => {
  it('signs and verifies bounded sessions', async () => {
    const token = await signSession({ sub: 'user-1' }, secret, 1000);
    const claims = await verifySession(token, secret, 1001);
    assert.equal(claims.sub, 'user-1');
    await assert.rejects(() => verifySession(token, secret, 1000 + 8 * 24 * 60 * 60));
  });

  it('rejects modified sessions', async () => {
    const token = await signSession({ sub: 'user-1' }, secret, 1000);
    await assert.rejects(() => verifySession(`${token.slice(0, -1)}x`, secret, 1001));
  });

  it('validates Stripe v1 signatures and timestamp tolerance', async () => {
    const payload = '{"id":"evt_1"}';
    const timestamp = 1_700_000_000;
    const signature = await hmacHex(`${timestamp}.${payload}`, secret);
    assert.equal(
      await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, secret, timestamp * 1000),
      true,
    );
    assert.equal(
      await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, secret, (timestamp + 301) * 1000),
      false,
    );
  });

  it('hashes stable identifiers without exposing the source', async () => {
    assert.equal((await sha256('device-1')).length, 64);
    assert.notEqual(await sha256('device-1'), await sha256('device-2'));
    assert.equal(constantTimeEqual('same', 'same'), true);
    assert.equal(constantTimeEqual('same', 'different'), false);
  });
});

describe('plans and authorization', () => {
  it('enforces role ordering', () => {
    assert.equal(hasRole('owner', 'admin'), true);
    assert.equal(hasRole('member', 'admin'), false);
    assert.equal(hasRole('viewer', 'viewer'), true);
  });

  it('falls back to free entitlements for inactive subscriptions', () => {
    assert.equal(entitlements({ plan: 'team', status: 'canceled', seats: 50 }).plan, 'free');
    const team = entitlements({ plan: 'team', status: 'active', seats: 24 });
    assert.equal(team.seats, 24);
    assert.equal(team.cloudSync, true);
  });

  it('requires configured Stripe prices', () => {
    assert.equal(stripePriceFor('pro', { STRIPE_PRICE_PRO: 'price_pro' }), 'price_pro');
    assert.throws(() => stripePriceFor('team', {}));
  });
});

async function hmacHex(value, keyValue) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyValue),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
