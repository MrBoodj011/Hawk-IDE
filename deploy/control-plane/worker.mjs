import {
  randomToken,
  sha256,
  signSession,
  verifySession,
  verifyStripeSignature,
} from './lib/crypto.mjs';
import { PLANS, ROLES, entitlements, hasRole, stripePriceFor } from './lib/plans.mjs';

const GITHUB_API = 'https://api.github.com';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const TELEMETRY_EVENTS = new Set([
  'app_started',
  'app_stopped',
  'command_completed',
  'command_failed',
  'agent_task_completed',
  'agent_task_failed',
  'desktop_crash',
  'update_checked',
  'update_installed',
]);

export default {
  async fetch(request, env) {
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    try {
      return withHeaders(await route(request, env), request, env, requestId);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('control-plane request failed', { requestId, error });
      return withHeaders(
        json({ error: status >= 500 ? 'internal server error' : error.message, requestId }, status),
        request,
        env,
        requestId,
      );
    }
  },
};

export async function route(request, env) {
  requireEnvironment(env);
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method === 'GET' && url.pathname === '/health') {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: true, service: 'hawk-control-plane', environment: env.HAWK_ENV || 'production' });
  }
  if (request.method === 'GET' && url.pathname === '/v1/plans') {
    return json({ plans: Object.values(PLANS) });
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/github/exchange') {
    return await githubCodeExchange(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/github/token') {
    return await githubTokenExchange(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/billing/webhook') {
    return await stripeWebhook(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/telemetry/events') {
    return await ingestTelemetry(request, env);
  }

  const actor = await authenticate(request, env);
  if (request.method === 'GET' && url.pathname === '/v1/me') {
    const organizations = await env.DB.prepare(
      `SELECT o.id, o.name, o.slug, m.role
       FROM organizations o JOIN memberships m ON m.organization_id = o.id
       WHERE m.user_id = ? ORDER BY o.name`,
    )
      .bind(actor.id)
      .all();
    return json({ user: publicUser(actor), organizations: organizations.results || [] });
  }
  if (request.method === 'POST' && url.pathname === '/v1/organizations') {
    return await createOrganization(request, env, actor);
  }

  const orgMatch = url.pathname.match(/^\/v1\/organizations\/([0-9a-f-]+)(.*)$/i);
  if (orgMatch) {
    const organizationId = orgMatch[1];
    const suffix = orgMatch[2] || '';
    const membership = await requireMembership(env, organizationId, actor.id, 'viewer');
    if (request.method === 'GET' && suffix === '') {
      return await organizationOverview(env, organizationId, membership);
    }
    if (request.method === 'GET' && suffix === '/members') {
      return await listMembers(env, organizationId, membership);
    }
    if (request.method === 'POST' && suffix === '/invitations') {
      requireRole(membership, 'admin');
      return await createInvitation(request, env, actor, organizationId);
    }
    if (request.method === 'GET' && suffix === '/workspaces') {
      return await listWorkspaces(env, organizationId, membership);
    }
    if (request.method === 'POST' && suffix === '/workspaces') {
      requireRole(membership, 'member');
      return await createWorkspace(request, env, actor, organizationId);
    }
    if (request.method === 'GET' && suffix === '/entitlements') {
      return await organizationEntitlements(env, organizationId, membership);
    }
    if (request.method === 'POST' && suffix === '/billing/checkout') {
      requireRole(membership, 'admin');
      return await createCheckout(request, env, actor, organizationId);
    }
    if (request.method === 'POST' && suffix === '/billing/portal') {
      requireRole(membership, 'admin');
      return await createBillingPortal(request, env, organizationId);
    }
    if (request.method === 'POST' && suffix === '/licenses/activate') {
      requireRole(membership, 'member');
      return await activateLicense(request, env, actor, organizationId);
    }
    if (request.method === 'POST' && suffix === '/licenses/deactivate') {
      requireRole(membership, 'member');
      return await deactivateLicense(request, env, actor, organizationId);
    }
    if (request.method === 'GET' && suffix === '/audit') {
      requireRole(membership, 'admin');
      return await listAudit(env, organizationId, url);
    }
    const memberMatch = suffix.match(/^\/members\/([0-9a-f-]+)$/i);
    if (memberMatch && request.method === 'PATCH') {
      requireRole(membership, 'owner');
      return await changeMemberRole(request, env, actor, organizationId, memberMatch[1]);
    }
    if (memberMatch && request.method === 'DELETE') {
      requireRole(membership, 'owner');
      return await removeMember(env, actor, organizationId, memberMatch[1]);
    }
  }

  const inviteMatch = url.pathname.match(/^\/v1\/invitations\/([A-Za-z0-9_-]+)\/accept$/);
  if (inviteMatch && request.method === 'POST') {
    return await acceptInvitation(env, actor, inviteMatch[1]);
  }

  const workspaceMatch = url.pathname.match(/^\/v1\/workspaces\/([0-9a-f-]+)\/state$/i);
  if (workspaceMatch) {
    if (request.method === 'GET') return await getWorkspaceState(env, actor, workspaceMatch[1]);
    if (request.method === 'PUT') {
      return await putWorkspaceState(request, env, actor, workspaceMatch[1]);
    }
  }
  throw new HttpError(404, 'not found');
}

async function githubCodeExchange(request, env) {
  const body = await readJson(request);
  const code = text(body.code, 'code', 8, 512);
  const redirectUri = allowedRedirect(body.redirectUri, env);
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    throw new HttpError(503, 'GitHub OAuth is not configured');
  }
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    throw new HttpError(401, 'GitHub authorization failed');
  }
  return await finishGithubSignIn(env, token.access_token);
}

async function githubTokenExchange(request, env) {
  const body = await readJson(request);
  const accessToken = text(body.accessToken, 'accessToken', 20, 512);
  return await finishGithubSignIn(env, accessToken);
}

async function finishGithubSignIn(env, accessToken) {
  const profileResponse = await githubFetch('/user', accessToken);
  if (!profileResponse.ok) throw new HttpError(401, 'GitHub authorization failed');
  const profile = await profileResponse.json();
  if (!Number.isInteger(profile.id) || !profile.login) {
    throw new HttpError(401, 'GitHub returned an invalid user profile');
  }
  let email = typeof profile.email === 'string' ? profile.email : null;
  if (!email) {
    const emailsResponse = await githubFetch('/user/emails', accessToken);
    if (emailsResponse.ok) {
      const emails = await emailsResponse.json();
      email =
        emails.find((candidate) => candidate.primary && candidate.verified)?.email ||
        emails.find((candidate) => candidate.verified)?.email ||
        null;
    }
  }
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE github_id = ?')
    .bind(profile.id)
    .first();
  const id = existing?.id || crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, login, email, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET
       login = excluded.login,
       email = excluded.email,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at`,
  )
    .bind(id, profile.id, profile.login, email, profile.avatar_url || null, now, now)
    .run();
  const session = await signSession(
    { sub: id, login: profile.login, email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
    env.SESSION_SIGNING_KEY,
  );
  return json(
    {
      token: session,
      expiresIn: SESSION_TTL_SECONDS,
      user: { id, login: profile.login, email, avatarUrl: profile.avatar_url || null },
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
}

async function createOrganization(request, env, actor) {
  const body = await readJson(request);
  const name = text(body.name, 'name', 2, 80);
  const slug = slugify(body.slug || name);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organizations (id, name, slug, owner_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, name, slug, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO memberships (organization_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      ).bind(id, actor.id, now),
      env.DB.prepare(
        `INSERT INTO subscriptions
         (organization_id, plan, status, seats, updated_at)
         VALUES (?, 'free', 'free', 1, ?)`,
      ).bind(id, now),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) {
      throw new HttpError(409, 'organization slug is already used');
    }
    throw error;
  }
  await audit(env, actor.id, id, 'organization.created', 'organization', id, { slug });
  return json({ organization: { id, name, slug, role: 'owner' } }, 201);
}

async function organizationOverview(env, organizationId, membership) {
  const organization = await env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.created_at,
       (SELECT COUNT(*) FROM memberships WHERE organization_id = o.id) AS members,
       (SELECT COUNT(*) FROM workspaces WHERE organization_id = o.id) AS workspaces
     FROM organizations o WHERE o.id = ?`,
  )
    .bind(organizationId)
    .first();
  if (!organization) throw new HttpError(404, 'organization not found');
  const subscription = await subscriptionFor(env, organizationId);
  return json({ organization: { ...organization, role: membership.role }, entitlements: entitlements(subscription) });
}

async function listMembers(env, organizationId, membership) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.login, u.email, u.avatar_url, m.role, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? ORDER BY m.created_at`,
  )
    .bind(organizationId)
    .all();
  return json({ role: membership.role, members: rows.results || [] });
}

async function createInvitation(request, env, actor, organizationId) {
  const body = await readJson(request);
  const email = emailAddress(body.email);
  const role = body.role || 'member';
  if (!ROLES.includes(role) || role === 'owner') throw new HttpError(400, 'invalid invitation role');
  const token = randomToken();
  const tokenHash = await sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO invitations
     (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      email,
      role,
      tokenHash,
      actor.id,
      expiresAt,
      now.toISOString(),
    )
    .run();
  await audit(env, actor.id, organizationId, 'member.invited', 'email', email, { role });
  return json({ invitation: { email, role, token, expiresAt } }, 201, {
    'Cache-Control': 'no-store',
  });
}

async function acceptInvitation(env, actor, token) {
  const tokenHash = await sha256(token);
  const invitation = await env.DB.prepare(
    `SELECT * FROM invitations
     WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first();
  if (!invitation) throw new HttpError(404, 'invitation is invalid or expired');
  if (!actor.email || actor.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new HttpError(403, 'invitation belongs to a different verified email');
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO memberships (organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role`,
    ).bind(invitation.organization_id, actor.id, invitation.role, now),
    env.DB.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').bind(now, invitation.id),
  ]);
  await audit(
    env,
    actor.id,
    invitation.organization_id,
    'member.joined',
    'user',
    actor.id,
    { role: invitation.role },
  );
  return json({ accepted: true, organizationId: invitation.organization_id });
}

async function changeMemberRole(request, env, actor, organizationId, userId) {
  const body = await readJson(request);
  if (!ROLES.includes(body.role) || body.role === 'owner') {
    throw new HttpError(400, 'role must be admin, member, or viewer');
  }
  const member = await env.DB.prepare(
    'SELECT role FROM memberships WHERE organization_id = ? AND user_id = ?',
  )
    .bind(organizationId, userId)
    .first();
  if (!member) throw new HttpError(404, 'member not found');
  if (member.role === 'owner') throw new HttpError(409, 'transfer ownership before changing owner');
  await env.DB.prepare(
    'UPDATE memberships SET role = ? WHERE organization_id = ? AND user_id = ?',
  )
    .bind(body.role, organizationId, userId)
    .run();
  await audit(env, actor.id, organizationId, 'member.role_changed', 'user', userId, {
    from: member.role,
    to: body.role,
  });
  return json({ updated: true, userId, role: body.role });
}

async function removeMember(env, actor, organizationId, userId) {
  const member = await env.DB.prepare(
    'SELECT role FROM memberships WHERE organization_id = ? AND user_id = ?',
  )
    .bind(organizationId, userId)
    .first();
  if (!member) throw new HttpError(404, 'member not found');
  if (member.role === 'owner') throw new HttpError(409, 'the organization owner cannot be removed');
  await env.DB.prepare('DELETE FROM memberships WHERE organization_id = ? AND user_id = ?')
    .bind(organizationId, userId)
    .run();
  await audit(env, actor.id, organizationId, 'member.removed', 'user', userId);
  return new Response(null, { status: 204 });
}

async function listWorkspaces(env, organizationId, membership) {
  const rows = await env.DB.prepare(
    `SELECT id, name, repository, revision, updated_at
     FROM workspaces WHERE organization_id = ? ORDER BY updated_at DESC`,
  )
    .bind(organizationId)
    .all();
  return json({ role: membership.role, workspaces: rows.results || [] });
}

async function createWorkspace(request, env, actor, organizationId) {
  const subscription = await subscriptionFor(env, organizationId);
  if (!entitlements(subscription).cloudSync) {
    throw new HttpError(402, 'cloud sync requires a Pro, Team, or Enterprise plan');
  }
  const body = await readJson(request);
  const name = text(body.name, 'name', 2, 100);
  const repository = optionalText(body.repository, 'repository', 240);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = '{}';
  await env.DB.prepare(
    `INSERT INTO workspaces
     (id, organization_id, name, repository, revision, state_json, state_hash, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  )
    .bind(id, organizationId, name, repository, state, await sha256(state), actor.id, now, now)
    .run();
  await audit(env, actor.id, organizationId, 'workspace.created', 'workspace', id, { repository });
  return json({ workspace: { id, name, repository, revision: 0 } }, 201);
}

async function getWorkspaceState(env, actor, workspaceId) {
  const workspace = await workspaceWithMembership(env, actor.id, workspaceId, 'viewer');
  return json(
    {
      workspace: {
        id: workspace.id,
        organizationId: workspace.organization_id,
        name: workspace.name,
        repository: workspace.repository,
        revision: workspace.revision,
        state: JSON.parse(workspace.state_json),
        hash: workspace.state_hash,
        updatedAt: workspace.updated_at,
      },
    },
    200,
    { ETag: `"${workspace.state_hash}"`, 'Cache-Control': 'private, no-store' },
  );
}

async function putWorkspaceState(request, env, actor, workspaceId) {
  const workspace = await workspaceWithMembership(env, actor.id, workspaceId, 'member');
  const subscription = await subscriptionFor(env, workspace.organization_id);
  if (!entitlements(subscription).cloudSync) {
    throw new HttpError(402, 'cloud sync is not available for this organization');
  }
  const body = await readJson(request, 256 * 1024);
  if (!Number.isInteger(body.revision) || body.revision < 0) {
    throw new HttpError(400, 'revision must be a non-negative integer');
  }
  if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
    throw new HttpError(400, 'state must be an object');
  }
  const serialized = JSON.stringify(body.state);
  if (new TextEncoder().encode(serialized).byteLength > 256 * 1024) {
    throw new HttpError(413, 'workspace state exceeds 256 KiB');
  }
  const hash = await sha256(serialized);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE workspaces SET
       state_json = ?, state_hash = ?, revision = revision + 1, updated_by = ?, updated_at = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(serialized, hash, actor.id, now, workspaceId, body.revision)
    .run();
  if (!result.meta?.changes) {
    const current = await env.DB.prepare('SELECT revision, state_hash FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first();
    return json({ error: 'sync conflict', current }, 409);
  }
  await audit(
    env,
    actor.id,
    workspace.organization_id,
    'workspace.synced',
    'workspace',
    workspaceId,
    { revision: body.revision + 1, hash },
  );
  return json({ revision: body.revision + 1, hash, updatedAt: now }, 200, { ETag: `"${hash}"` });
}

async function organizationEntitlements(env, organizationId, membership) {
  const subscription = await subscriptionFor(env, organizationId);
  const activeDevices = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM license_activations
     WHERE organization_id = ? AND last_seen_at > ?`,
  )
    .bind(organizationId, new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString())
    .first();
  return json({
    role: membership.role,
    entitlements: entitlements(subscription),
    activeDevices: Number(activeDevices?.count || 0),
  });
}

async function activateLicense(request, env, actor, organizationId) {
  const body = await readJson(request);
  const deviceId = text(body.deviceId, 'deviceId', 16, 256);
  const deviceName = optionalText(body.deviceName, 'deviceName', 100);
  const deviceHash = await sha256(deviceId);
  const subscription = await subscriptionFor(env, organizationId);
  const grants = entitlements(subscription);
  const existing = await env.DB.prepare(
    'SELECT user_id FROM license_activations WHERE organization_id = ? AND device_hash = ?',
  )
    .bind(organizationId, deviceHash)
    .first();
  if (!existing) {
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM license_activations
       WHERE organization_id = ? AND last_seen_at > ?`,
    )
      .bind(organizationId, new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString())
      .first();
    if (Number(active?.count || 0) >= grants.seats) {
      throw new HttpError(409, 'all licensed seats are already active');
    }
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO license_activations
     (organization_id, user_id, device_hash, device_name, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, device_hash) DO UPDATE SET
       user_id = excluded.user_id,
       device_name = excluded.device_name,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(organizationId, actor.id, deviceHash, deviceName, now, now)
    .run();
  const license = await signSession(
    {
      sub: actor.id,
      organizationId,
      device: deviceHash,
      entitlements: grants,
      type: 'hawk-license',
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    },
    env.LICENSE_SIGNING_KEY || env.SESSION_SIGNING_KEY,
  );
  await audit(env, actor.id, organizationId, 'license.activated', 'device', deviceHash, {
    deviceName,
  });
  return json({ license, expiresIn: 86400, entitlements: grants }, 200, {
    'Cache-Control': 'no-store',
  });
}

async function deactivateLicense(request, env, actor, organizationId) {
  const body = await readJson(request);
  const deviceHash = await sha256(text(body.deviceId, 'deviceId', 16, 256));
  await env.DB.prepare(
    'DELETE FROM license_activations WHERE organization_id = ? AND device_hash = ? AND user_id = ?',
  )
    .bind(organizationId, deviceHash, actor.id)
    .run();
  await audit(env, actor.id, organizationId, 'license.deactivated', 'device', deviceHash);
  return new Response(null, { status: 204 });
}

async function createCheckout(request, env, actor, organizationId) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Stripe is not configured');
  const body = await readJson(request);
  const plan = text(body.plan, 'plan', 3, 20);
  if (!['pro', 'team', 'enterprise'].includes(plan)) throw new HttpError(400, 'invalid paid plan');
  const seats = integer(body.seats || PLANS[plan].seats, 'seats', 1, 1000);
  const urls = billingReturnUrls(body, env);
  let subscription = await subscriptionFor(env, organizationId);
  let customerId = subscription?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripeRequest(env, '/v1/customers', {
      email: actor.email || undefined,
      name: actor.login,
      'metadata[organization_id]': organizationId,
    });
    customerId = customer.id;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO subscriptions
       (organization_id, stripe_customer_id, plan, status, seats, updated_at)
       VALUES (?, ?, 'free', 'free', 1, ?)
       ON CONFLICT(organization_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id`,
    )
      .bind(organizationId, customerId, now)
      .run();
    subscription = await subscriptionFor(env, organizationId);
  }
  const session = await stripeRequest(env, '/v1/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: organizationId,
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    'line_items[0][price]': stripePriceFor(plan, env),
    'line_items[0][quantity]': String(seats),
    'metadata[organization_id]': organizationId,
    'metadata[plan]': plan,
    'subscription_data[metadata][organization_id]': organizationId,
    'subscription_data[metadata][plan]': plan,
    allow_promotion_codes: 'true',
  });
  await audit(env, actor.id, organizationId, 'billing.checkout_created', 'checkout', session.id, {
    plan,
    seats,
  });
  return json({ url: session.url, id: session.id }, 201, { 'Cache-Control': 'no-store' });
}

async function createBillingPortal(request, env, organizationId) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Stripe is not configured');
  const subscription = await subscriptionFor(env, organizationId);
  if (!subscription?.stripe_customer_id) throw new HttpError(409, 'organization has no billing account');
  const body = await readJson(request);
  const returnUrl = safeReturnUrl(body.returnUrl, env);
  const session = await stripeRequest(env, '/v1/billing_portal/sessions', {
    customer: subscription.stripe_customer_id,
    return_url: returnUrl,
  });
  return json({ url: session.url }, 201, { 'Cache-Control': 'no-store' });
}

async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhook is not configured');
  const raw = await request.text();
  const valid = await verifyStripeSignature(
    raw,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) throw new HttpError(400, 'invalid Stripe signature');
  const event = JSON.parse(raw);
  const object = event?.data?.object;
  if (!event?.id || !object) throw new HttpError(400, 'invalid Stripe event');
  const receipt = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events (id, provider, received_at)
     VALUES (?, 'stripe', ?)`,
  )
    .bind(event.id, new Date().toISOString())
    .run();
  if (!receipt.meta?.changes) return json({ received: true, duplicate: true });
  if (event.type === 'checkout.session.completed') {
    const organizationId = object.metadata?.organization_id || object.client_reference_id;
    if (organizationId) {
      await env.DB.prepare(
        `UPDATE subscriptions SET
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         updated_at = ?
         WHERE organization_id = ?`,
      )
        .bind(object.customer || null, object.subscription || null, new Date().toISOString(), organizationId)
        .run();
    }
  }
  if (event.type.startsWith('customer.subscription.')) {
    const organizationId = object.metadata?.organization_id;
    if (organizationId) {
      const plan = PLANS[object.metadata?.plan] ? object.metadata.plan : 'free';
      const seats = Number(object.items?.data?.[0]?.quantity || PLANS[plan].seats);
      const periodEnd = object.current_period_end
        ? new Date(object.current_period_end * 1000).toISOString()
        : null;
      await env.DB.prepare(
        `UPDATE subscriptions SET
         stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = ?,
         seats = ?, current_period_end = ?, updated_at = ?
         WHERE organization_id = ?`,
      )
        .bind(
          object.customer,
          object.id,
          event.type === 'customer.subscription.deleted' ? 'free' : plan,
          event.type === 'customer.subscription.deleted' ? 'canceled' : object.status,
          Math.max(1, seats),
          periodEnd,
          new Date().toISOString(),
          organizationId,
        )
        .run();
      await audit(env, null, organizationId, `billing.${event.type.split('.').pop()}`, 'subscription', object.id, {
        plan,
        status: object.status,
      });
    }
  }
  return json({ received: true });
}

async function ingestTelemetry(request, env) {
  const body = await readJson(request, 16 * 1024);
  if (!TELEMETRY_EVENTS.has(body.event)) throw new HttpError(400, 'unsupported telemetry event');
  const installationId = text(
    request.headers.get('x-hawk-installation-id'),
    'X-Hawk-Installation-Id',
    16,
    256,
  );
  const properties =
    body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)
      ? sanitizeTelemetryProperties(body.properties)
      : {};
  let userId = null;
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    try {
      userId = (await verifySession(authorization.slice(7), env.SESSION_SIGNING_KEY)).sub;
    } catch {
      userId = null;
    }
  }
  await env.DB.prepare(
    `INSERT INTO telemetry_events
     (id, installation_hash, user_id, event_name, release, platform, properties_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await sha256(installationId),
      userId,
      body.event,
      optionalText(body.release, 'release', 80),
      optionalText(body.platform, 'platform', 40),
      JSON.stringify(properties),
      new Date().toISOString(),
    )
    .run();
  return new Response(null, { status: 202 });
}

async function listAudit(env, organizationId, url) {
  const limit = integer(Number(url.searchParams.get('limit') || 100), 'limit', 1, 250);
  const rows = await env.DB.prepare(
    `SELECT id, actor_user_id, action, target_type, target_id, metadata_json, created_at
     FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(organizationId, limit)
    .all();
  return json({
    events: (rows.results || []).map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata_json),
      metadata_json: undefined,
    })),
  });
}

async function authenticate(request, env) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'authentication required');
  let claims;
  try {
    claims = await verifySession(authorization.slice(7), env.SESSION_SIGNING_KEY);
  } catch {
    throw new HttpError(401, 'invalid or expired session');
  }
  const user = await env.DB.prepare(
    'SELECT id, login, email, avatar_url FROM users WHERE id = ?',
  )
    .bind(claims.sub)
    .first();
  if (!user) throw new HttpError(401, 'user no longer exists');
  return user;
}

async function requireMembership(env, organizationId, userId, role) {
  const membership = await env.DB.prepare(
    `SELECT m.role, o.name, o.slug
     FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.organization_id = ? AND m.user_id = ?`,
  )
    .bind(organizationId, userId)
    .first();
  if (!membership) throw new HttpError(404, 'organization not found');
  requireRole(membership, role);
  return membership;
}

function requireRole(membership, role) {
  if (!hasRole(membership.role, role)) throw new HttpError(403, `${role} role required`);
}

async function workspaceWithMembership(env, userId, workspaceId, role) {
  const workspace = await env.DB.prepare(
    `SELECT w.*, m.role
     FROM workspaces w JOIN memberships m ON m.organization_id = w.organization_id
     WHERE w.id = ? AND m.user_id = ?`,
  )
    .bind(workspaceId, userId)
    .first();
  if (!workspace) throw new HttpError(404, 'workspace not found');
  requireRole(workspace, role);
  return workspace;
}

async function subscriptionFor(env, organizationId) {
  return await env.DB.prepare('SELECT * FROM subscriptions WHERE organization_id = ?')
    .bind(organizationId)
    .first();
}

async function audit(env, actorId, organizationId, action, targetType, targetId, metadata = {}) {
  await env.DB.prepare(
    `INSERT INTO audit_log
     (id, organization_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      actorId,
      action,
      targetType,
      targetId,
      JSON.stringify(metadata),
      new Date().toISOString(),
    )
    .run();
}

async function githubFetch(path, token) {
  return await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Hawk-Control-Plane/1',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

async function stripeRequest(env, path, values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body,
  });
  const result = await response.json();
  if (!response.ok) {
    console.error('Stripe request failed', { status: response.status, type: result?.error?.type });
    throw new HttpError(502, 'billing provider request failed');
  }
  return result;
}

async function readJson(request, maximumBytes = 64 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw new HttpError(413, 'request body is too large');
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError(400, 'request body could not be read');
  }
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new HttpError(413, 'request body is too large');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
}

function text(value, name, minimum, maximum) {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new HttpError(400, `${name} must contain ${minimum}-${maximum} characters`);
  }
  return normalized;
}

function optionalText(value, name, maximum) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, name, 1, maximum);
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function emailAddress(value) {
  const email = text(value, 'email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid email');
  return email;
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  if (slug.length < 2) throw new HttpError(400, 'organization slug is invalid');
  return slug;
}

function allowedRedirect(value, env) {
  const redirect = text(value, 'redirectUri', 8, 500);
  const allowed = String(env.OAUTH_REDIRECT_URIS || '')
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (!allowed.includes(redirect)) throw new HttpError(400, 'redirect URI is not allowed');
  return redirect;
}

function billingReturnUrls(body, env) {
  return {
    successUrl: safeReturnUrl(body.successUrl, env),
    cancelUrl: safeReturnUrl(body.cancelUrl, env),
  };
}

function safeReturnUrl(value, env) {
  const candidate = new URL(text(value, 'return URL', 8, 500));
  const allowed = String(env.BILLING_RETURN_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowed.includes(candidate.origin)) throw new HttpError(400, 'return URL origin is not allowed');
  return candidate.toString();
}

function sanitizeTelemetryProperties(value) {
  const blocked = /(code|source|prompt|response|request|header|cookie|token|secret|path|url|email)/i;
  const clean = {};
  for (const [key, property] of Object.entries(value).slice(0, 30)) {
    if (blocked.test(key) || key.length > 50) continue;
    if (typeof property === 'string') clean[key] = property.slice(0, 200);
    else if (typeof property === 'number' || typeof property === 'boolean') clean[key] = property;
  }
  return clean;
}

function publicUser(actor) {
  return {
    id: actor.id,
    login: actor.login,
    email: actor.email,
    avatarUrl: actor.avatar_url,
  };
}

function requireEnvironment(env) {
  if (!env.DB) throw new Error('D1 binding DB is not configured');
  if (!env.SESSION_SIGNING_KEY) throw new Error('SESSION_SIGNING_KEY is not configured');
}

function withHeaders(response, request, env, requestId) {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  const origin = request.headers.get('origin');
  const allowedOrigins = String(env.CORS_ORIGINS || '')
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Hawk-Installation-Id');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
