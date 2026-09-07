/**
 * Token lifetimes come from the environment.
 *
 * Four values that were hard-coded (15 minutes and 30 days, for end-users
 * and for operators) are deployment settings now. Pinned here: the defaults
 * are the old constants, and each issuer actually reads its setting rather
 * than a private copy of the number.
 */

import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';
import { issueTenantAccessToken } from '../src/lib/tenant-jwt.js';
import { issueUserAccessToken } from '../src/lib/jwt.js';

function lifetimeOf(token: string): number {
  const claims = jwt.decode(token) as { iat: number; exp: number };
  return claims.exp - claims.iat;
}

describe('token lifetimes', () => {
  it('defaults are the values that used to be hard-coded', () => {
    expect(env.END_USER_ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(env.END_USER_REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(env.OPERATOR_REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('the operator access token lasts OPERATOR_ACCESS_TOKEN_TTL_SECONDS', () => {
    const { token, expiresAt } = issueTenantAccessToken('user_1', 'tenant_1', 'MEMBER');
    expect(lifetimeOf(token)).toBe(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS);
    expect(Math.round((expiresAt.getTime() - Date.now()) / 1000)).toBeCloseTo(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS, -1);
  });

  it('the end-user access token lasts END_USER_ACCESS_TOKEN_TTL_SECONDS', () => {
    const issued = issueUserAccessToken('eu_1', 'app_1', 'USER' as never, {});
    expect(lifetimeOf(issued.token)).toBe(env.END_USER_ACCESS_TOKEN_TTL_SECONDS);
  });

  it('an explicit lifetime still wins over the setting', () => {
    const { token } = issueTenantAccessToken('user_1', 'tenant_1', 'MEMBER', { lifetimeSeconds: 120 });
    expect(lifetimeOf(token)).toBe(120);
  });
});
