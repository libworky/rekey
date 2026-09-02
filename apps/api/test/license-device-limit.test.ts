/**
 * `max_devices` bounds PERPETUAL and TIMED licenses — the fourth step of the
 * device series. Before it, those kinds accepted unlimited activations
 * (documented as "no upper bound today"). Now the holder's entitlement is the
 * bound; SEATS keeps its own `seatsAllowed`; org-pooled licenses and holders
 * with no such entitlement are unchanged.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';

describe('max_devices bounds perpetual and timed licenses', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ld-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'LD', slug: `ld-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  async function makeEndUser(email: string): Promise<{ id: string }> {
    const id = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);
    return { id };
  }

  async function setDefaultDeviceLimit(limit: number): Promise<void> {
    const slug = `free-${limit}`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'FEATURE', key: 'max_devices', valueType: 'INT', value: String(limit) },
    });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: { billingConfig: { ...(application.billingConfig as object), defaultPlanSlug: slug } as never },
    });
  }

  async function issue(endUserId: string, kind: 'PERPETUAL' | 'TIMED' | 'SEATS', extra: Record<string, unknown> = {}) {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } });
    return licensesService.issue({ application, endUser, kind, ...extra } as never);
  }

  const verify = (rawKey: string, fp: string) =>
    licensesService.verify({ applicationId: appId, rawKey, machineFingerprint: fp });

  it('caps a PERPETUAL license at the holder\'s max_devices and frees a slot on deactivate', async () => {
    await setDefaultDeviceLimit(2);
    const { id } = await makeEndUser('a@example.com');
    const { rawKey } = await issue(id, 'PERPETUAL');

    expect((await verify(rawKey, 'fp-a-1-xxxxxxx')).ok).toBe(true);
    expect((await verify(rawKey, 'fp-a-2-xxxxxxx')).ok).toBe(true);
    const third = await verify(rawKey, 'fp-a-3-xxxxxxx');
    expect(third).toMatchObject({ ok: false, reason: 'seats_exhausted' });
    // A known machine keeps verifying at the cap.
    expect((await verify(rawKey, 'fp-a-1-xxxxxxx')).ok).toBe(true);

    const released = await licensesService.deactivate({ applicationId: appId, rawKey, machineFingerprint: 'fp-a-1-xxxxxxx' });
    expect(released).toEqual({ ok: true, released: true });
    expect((await verify(rawKey, 'fp-a-3-xxxxxxx')).ok).toBe(true);
  });

  it('leaves a PERPETUAL license uncapped when no plan grants max_devices', async () => {
    const { id } = await makeEndUser('b@example.com');
    const { rawKey } = await issue(id, 'PERPETUAL');
    for (let i = 0; i < 6; i++) expect((await verify(rawKey, `fp-b-${i}-xxxxxxx`)).ok).toBe(true);
  });

  it('SEATS keeps seatsAllowed as its own cap, whatever max_devices says', async () => {
    await setDefaultDeviceLimit(1);
    const { id } = await makeEndUser('c@example.com');
    const { rawKey } = await issue(id, 'SEATS', { seatsAllowed: 3 });
    expect((await verify(rawKey, 'fp-c-1-xxxxxxx')).ok).toBe(true);
    expect((await verify(rawKey, 'fp-c-2-xxxxxxx')).ok).toBe(true);
    expect((await verify(rawKey, 'fp-c-3-xxxxxxx')).ok).toBe(true);
    expect((await verify(rawKey, 'fp-c-4-xxxxxxx')).reason).toBe('seats_exhausted');
  });

  it('a TIMED license is bounded the same way', async () => {
    await setDefaultDeviceLimit(1);
    const { id } = await makeEndUser('d@example.com');
    const { rawKey } = await issue(id, 'TIMED', { expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await verify(rawKey, 'fp-d-1-xxxxxxx')).ok).toBe(true);
    expect((await verify(rawKey, 'fp-d-2-xxxxxxx')).reason).toBe('seats_exhausted');
  });
});
