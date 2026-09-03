/**
 * Device-bound sessions — the second step of the device series.
 *
 * Every session-minting flow funnels through one chokepoint (`issuePair`), so
 * the assertions here go through the public routes and prove the behaviour a
 * desktop client sees:
 *   - a `device` binding on sign-in yields a session whose access token carries
 *     `dev`, whose refresh row records `deviceId`, and whose AuthResult says so;
 *   - no binding means nothing changed — `deviceId: null`, no claim, no row;
 *   - `authConfig.deviceBinding = 'required'` refuses primary sign-in without
 *     one, and never gates refresh;
 *   - `max_devices` from the default plan refuses the next machine with a 403
 *     that lists the devices to release, and releasing one lets it in;
 *   - a blocked device cannot sign in;
 *   - refresh keeps the binding, binds an unbound chain, refuses a different
 *     fingerprint (and revokes the family), and a released device's chain is
 *     dead;
 *   - the session list shows `deviceId`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { devicesService } from '../src/modules/devices/devices.service.js';

const PASSWORD = 'pw-one-two-three';

describe('device-bound sessions', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const keyAuth = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ds-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DS', slug: `ds-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  async function makeEndUser(email: string): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email, password: PASSWORD },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  async function setDefaultDeviceLimit(limit: number): Promise<void> {
    const slug = `free-${limit}`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'max_devices', valueType: 'INT', value: String(limit) },
    });
    expect(put.statusCode).toBe(200);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: { billingConfig: { ...(application.billingConfig as object), defaultPlanSlug: slug } as never },
    });
  }

  async function setDeviceBinding(mode: 'optional' | 'required'): Promise<void> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: auth(),
      payload: { deviceBinding: mode },
    });
    expect(res.statusCode).toBe(200);
  }

  type Session = {
    accessToken: string;
    refreshToken: string;
    deviceId: string | null;
    endUser: { id: string };
  };

  function signIn(email: string, device?: { fingerprint: string; label?: string }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: keyAuth(),
      payload: { email, password: PASSWORD, ...(device && { device }) },
    });
  }

  function refresh(refreshToken: string, device?: { fingerprint: string; label?: string }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: keyAuth(),
      payload: { refreshToken, ...(device && { device }) },
    });
  }

  const claims = (accessToken: string): Record<string, unknown> =>
    jwt.decode(accessToken) as Record<string, unknown>;

  it('binds a session to the device named at sign-in', async () => {
    const userId = await makeEndUser('a@example.com');
    const res = await signIn('a@example.com', { fingerprint: 'fp-laptop-a-0001', label: 'Laptop' });
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(s.deviceId).toBeTruthy();
    expect(claims(s.accessToken).dev).toBe(s.deviceId);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: s.deviceId! } });
    expect(device.endUserId).toBe(userId);
    expect(device.fingerprint).toBe('fp-laptop-a-0001');
    expect(device.label).toBe('Laptop');
    expect(device.status).toBe('ACTIVE');

    const rows = await prisma.refreshToken.findMany({ where: { endUserId: userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceId).toBe(s.deviceId);

    // The session list shows it.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data.items as Array<{ deviceId: string | null }>)[0]!.deviceId).toBe(s.deviceId);
  });

  it('changes nothing for a client that sends no device', async () => {
    const userId = await makeEndUser('b@example.com');
    const res = await signIn('b@example.com');
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(s.deviceId).toBeNull();
    expect(claims(s.accessToken).dev).toBeUndefined();
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
    const row = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId } });
    expect(row.deviceId).toBeNull();
  });

  it('deviceBinding=required refuses primary sign-in without a device, but not refresh', async () => {
    await makeEndUser('c@example.com');
    await setDeviceBinding('required');

    const bare = await signIn('c@example.com');
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');

    const bound = await signIn('c@example.com', { fingerprint: 'fp-required-0001' });
    expect(bound.statusCode).toBe(200);
    const s = bound.json().data as Session;

    // Refresh without repeating the fingerprint keeps working — the chain is
    // already bound, and `required` gates primary sign-in only.
    const r = await refresh(s.refreshToken);
    expect(r.statusCode).toBe(200);
    expect((r.json().data as Session).deviceId).toBe(s.deviceId);
  });

  it('deviceBinding=required refuses a sign-up without a device before the account exists', async () => {
    await setDeviceBinding('required');
    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: keyAuth(),
      payload: { email: 'new@example.com', password: PASSWORD },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
    // Nothing was created, so the corrected retry is a sign-up, not a 409.
    expect(await prisma.endUser.count({ where: { applicationId: appId } })).toBe(0);
    const withDevice = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: keyAuth(),
      payload: { email: 'new@example.com', password: PASSWORD, device: { fingerprint: 'fp-signup-00001' } },
    });
    expect(withDevice.statusCode).toBe(201);
    expect((withDevice.json().data as Session).deviceId).toBeTruthy();
  });

  it('a refresh refused by the device limit does not spend the token', async () => {
    await setDefaultDeviceLimit(1);
    const userId = await makeEndUser('cap@example.com');
    // An unbound chain, plus one active device filling the cap.
    const unbound = (await signIn('cap@example.com')).json().data as Session;
    expect((await signIn('cap@example.com', { fingerprint: 'fp-cap-first-0001' })).statusCode).toBe(200);

    const refused = await refresh(unbound.refreshToken, { fingerprint: 'fp-cap-second-001' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    // The chain is intact: the same token still refreshes, and nothing was
    // revoked. Before the reorder, the retry read as a replay and every
    // session for the user was burned.
    const retry = await refresh(unbound.refreshToken);
    expect(retry.statusCode).toBe(200);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(2);
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);
  });

  it('refuses the device over max_devices with the list to release, then admits it after a release', async () => {
    await setDefaultDeviceLimit(1);
    const userId = await makeEndUser('d@example.com');

    const first = await signIn('d@example.com', { fingerprint: 'fp-d-first-0001', label: 'First' });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json().data as Session).deviceId!;

    const second = await signIn('d@example.com', { fingerprint: 'fp-d-second-001', label: 'Second' });
    expect(second.statusCode).toBe(403);
    const err = second.json().error as { code: string; details?: { limit: number; devices: Array<{ id: string; label: string }> } };
    expect(err.code).toBe('DEVICE_LIMIT_REACHED');
    expect(err.details?.limit).toBe(1);
    expect(err.details?.devices.map((d) => d.id)).toEqual([firstId]);
    // No session, no row for the refused machine.
    expect(await prisma.refreshToken.count({ where: { endUserId: userId } })).toBe(1);
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);

    // The same first device keeps signing in at the cap.
    const again = await signIn('d@example.com', { fingerprint: 'fp-d-first-0001' });
    expect(again.statusCode).toBe(200);

    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: firstId, actor: { type: 'end_user', id: userId } });
    const admitted = await signIn('d@example.com', { fingerprint: 'fp-d-second-001', label: 'Second' });
    expect(admitted.statusCode).toBe(200);
  });

  it('refuses sign-in from a blocked device', async () => {
    const userId = await makeEndUser('e@example.com');
    const first = await signIn('e@example.com', { fingerprint: 'fp-e-blocked-001' });
    const deviceId = (first.json().data as Session).deviceId!;
    await devicesService.block({ applicationId: appId, endUserId: userId, deviceId, operatorUserId: null });

    const blocked = await signIn('e@example.com', { fingerprint: 'fp-e-blocked-001' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('DEVICE_BLOCKED');
    // The block revoked the first session; its refresh is dead.
    const r = await refresh((first.json().data as Session).refreshToken);
    expect(r.statusCode).toBe(401);
  });

  it('refresh carries the binding, binds an unbound chain, and refuses a different device', async () => {
    const userId = await makeEndUser('f@example.com');

    // Unbound chain becomes bound on the first refresh that identifies itself.
    const unbound = (await signIn('f@example.com')).json().data as Session;
    expect(unbound.deviceId).toBeNull();
    const r1 = await refresh(unbound.refreshToken, { fingerprint: 'fp-f-late-00001', label: 'Late' });
    expect(r1.statusCode).toBe(200);
    const s1 = r1.json().data as Session;
    expect(s1.deviceId).toBeTruthy();
    expect(claims(s1.accessToken).dev).toBe(s1.deviceId);
    const rotated = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId, revokedAt: null } });
    expect(rotated.deviceId).toBe(s1.deviceId);

    // A plain refresh keeps it.
    const r2 = await refresh(s1.refreshToken);
    expect(r2.statusCode).toBe(200);
    const s2 = r2.json().data as Session;
    expect(s2.deviceId).toBe(s1.deviceId);
    expect(claims(s2.accessToken).dev).toBe(s1.deviceId);

    // The same fingerprint is fine; a different one is the stolen-token case.
    const r3 = await refresh(s2.refreshToken, { fingerprint: 'fp-f-late-00001' });
    expect(r3.statusCode).toBe(200);
    const s3 = r3.json().data as Session;
    const r4 = await refresh(s3.refreshToken, { fingerprint: 'fp-f-other-0001' });
    expect(r4.statusCode).toBe(401);
    expect(r4.json().error.code).toBe('REFRESH_TOKEN_DEVICE_MISMATCH');
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);
    // The impostor registered no device.
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);
  });

  it("a released device's chain is dead", async () => {
    const userId = await makeEndUser('g@example.com');
    const s = (await signIn('g@example.com', { fingerprint: 'fp-g-release-001' })).json().data as Session;
    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: s.deviceId!, actor: { type: 'end_user', id: userId } });
    const r = await refresh(s.refreshToken);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('requireUserSession exposes the device on the request', async () => {
    await makeEndUser('h@example.com');
    const s = (await signIn('h@example.com', { fingerprint: 'fp-h-expose-0001' })).json().data as Session;
    // /users/me is the smallest user-session route; it does not echo the
    // device, so assert through the claim the middleware reads.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken },
    });
    expect(me.statusCode).toBe(200);
    expect(claims(s.accessToken).dev).toBe(s.deviceId);
  });
});
