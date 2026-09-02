/**
 * Hardening — the last step of the device series:
 *   - the licence routes are throttled per (application, key, fingerprint),
 *     both hashed, rather than per IP;
 *   - GDPR erasure deletes a person's devices and tombstones the fingerprint
 *     on retained license activations;
 *   - MCP tools over devices for operators (list / release / block / unblock)
 *     and for the signed-in user (list_my_devices).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { licenseRateLimitKey } from '../src/lib/rate-limit.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { accountTools } from '../src/modules/mcp/account-tools.js';

const PASSWORD = 'pw-one-two-three';

describe('device hardening', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let tenantId: string;
  let tenantUserId: string;

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
    const email = `dh-${slug}@example.com`;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DH', slug: `dh-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    tenantId = application.tenantId;
    tenantUserId = (await prisma.tenantUser.findFirstOrThrow({ where: { email } })).id;
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

  const ctx = (): OperatorToolContext => ({
    tenantUserId,
    tenantId,
    role: 'OWNER',
    canWrite: true,
    canAdmin: true,
  });

  const tool = (name: string) => {
    const t = operatorWriteTools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  };

  it('throttles licence verify per (application, key, fingerprint) with both hashed', () => {
    const req = (body: unknown, application?: string) =>
      ({ body, application: application ? { id: application } : undefined, ip: '203.0.113.9' }) as unknown as FastifyRequest;
    const a = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1'));
    const b = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-2' }, 'app1'));
    const c = licenseRateLimitKey(req({ key: 'rl_lic_other', machineFingerprint: 'fp-1' }, 'app1'));
    const d = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app2'));
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toMatch(/^license:app1:[0-9a-f]{32}:[0-9a-f]{32}$/);
    expect(a).not.toContain('rl_lic_secret');
    expect(a).not.toContain('fp-1');
    expect(a).not.toContain('203.0.113.9');
    // Same inputs, same bucket — an office behind one NAT is many buckets, one key many exit nodes is one.
    expect(licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1'))).toBe(a);
  });

  it('erasure deletes devices and tombstones activation fingerprints while keeping the rows', async () => {
    const userId = await makeEndUser('erase@example.com');
    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-erase-0000001', label: 'PC' });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
    const { rawKey, license } = await licensesService.issue({ application, endUser, kind: 'PERPETUAL' });
    expect((await licensesService.verify({ applicationId: appId, rawKey, machineFingerprint: 'fp-erase-0000001' })).ok).toBe(true);
    const before = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(before.deviceId).not.toBeNull();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${userId}?erasure=true`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
    const after = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(after.machineFingerprint).toBe(`erased:${after.id}`);
    expect(after.label).toBeNull();
    expect(after.deviceId).toBeNull();
    // The license row itself is retained, as documented.
    expect(await prisma.license.count({ where: { id: license.id } })).toBe(1);
  });

  it('operator MCP tools list, block, unblock and release devices within the workspace only', async () => {
    const userId = await makeEndUser('mcp@example.com');
    const t = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-mcp-00000001', label: 'MCP' });
    if (t.kind !== 'ok') throw new Error('expected ok');

    const listed = (await tool('list_devices').handler(ctx(), { applicationId: appId, endUserId: userId })) as {
      total: number;
      devices: Array<{ id: string; status: string }>;
    };
    expect(listed.total).toBe(1);
    expect(listed.devices[0]!.id).toBe(t.device.id);

    const blocked = (await tool('block_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id, reason: 'fraud' })) as {
      device: { status: string; blockedReason: string | null };
    };
    expect(blocked.device.status).toBe('BLOCKED');
    expect(blocked.device.blockedReason).toBe('fraud');

    const unblocked = (await tool('unblock_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id })) as {
      device: { status: string };
    };
    expect(unblocked.device.status).toBe('RELEASED');

    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-mcp-00000001' });
    const released = (await tool('release_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id })) as {
      device: { status: string };
      sessionsRevoked: number;
    };
    expect(released.device.status).toBe('RELEASED');

    // Another workspace's operator cannot see this end-user.
    const other = ctx();
    other.tenantId = 'not-this-tenant';
    other.tenantUserId = 'nobody';
    await expect(tool('list_devices').handler(other, { applicationId: appId, endUserId: userId })).rejects.toBeTruthy();

    // The write tools are marked as writes.
    for (const name of ['release_device', 'block_device', 'unblock_device']) expect(tool(name).write).toBe(true);
    expect(tool('list_devices').write).toBeFalsy();
  });

  it('end-user MCP list_my_devices returns the signed-in user\'s devices without IPs', async () => {
    const userId = await makeEndUser('me@example.com');
    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-me-000000001', label: 'Mine', ip: '203.0.113.5' });
    const t = accountTools.find((x) => x.name === 'list_my_devices');
    if (!t) throw new Error('tool missing');
    const out = (await t.handler({ applicationId: appId, endUserId: userId })) as { devices: Array<Record<string, unknown>> };
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0]!.label).toBe('Mine');
    expect(out.devices[0]).not.toHaveProperty('lastSeenIp');
    expect(out.devices[0]).not.toHaveProperty('fingerprint');
  });
});
