export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free',
    seats: 1,
    parallelWorkers: 2,
    cloudSync: false,
    auditRetentionDays: 7,
    privateMcpRegistry: false,
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    seats: 1,
    parallelWorkers: 12,
    cloudSync: true,
    auditRetentionDays: 90,
    privateMcpRegistry: true,
  }),
  team: Object.freeze({
    id: 'team',
    name: 'Team',
    seats: 10,
    parallelWorkers: 48,
    cloudSync: true,
    auditRetentionDays: 365,
    privateMcpRegistry: true,
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    name: 'Enterprise',
    seats: 100,
    parallelWorkers: 256,
    cloudSync: true,
    auditRetentionDays: 730,
    privateMcpRegistry: true,
  }),
});

export const ROLES = Object.freeze(['owner', 'admin', 'member', 'viewer']);

const ROLE_RANK = Object.freeze({
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
});

export function hasRole(actual, required) {
  return (ROLE_RANK[actual] || 0) >= (ROLE_RANK[required] || Number.POSITIVE_INFINITY);
}

export function entitlements(subscription) {
  const active = ['active', 'trialing'].includes(subscription?.status);
  const plan = active && PLANS[subscription?.plan] ? subscription.plan : 'free';
  const definition = PLANS[plan];
  const seats =
    active && Number.isInteger(subscription?.seats) && subscription.seats > 0
      ? subscription.seats
      : definition.seats;
  return {
    plan,
    status: active ? subscription.status : 'free',
    seats,
    parallelWorkers: definition.parallelWorkers,
    cloudSync: definition.cloudSync,
    auditRetentionDays: definition.auditRetentionDays,
    privateMcpRegistry: definition.privateMcpRegistry,
    currentPeriodEnd: subscription?.current_period_end || null,
  };
}

export function stripePriceFor(plan, env) {
  const key = {
    pro: 'STRIPE_PRICE_PRO',
    team: 'STRIPE_PRICE_TEAM',
    enterprise: 'STRIPE_PRICE_ENTERPRISE',
  }[plan];
  if (!key || !env[key]) throw new Error(`Stripe price is not configured for ${plan}`);
  return env[key];
}
