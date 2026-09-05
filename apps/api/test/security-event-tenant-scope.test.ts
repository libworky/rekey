/**
 * A security event written without a `tenantId` is invisible, not missing.
 *
 * `securityEventWhere` scopes every tenant-facing read by `tenantId`, so a row
 * recorded with only an `applicationId` is durable, correct, and unreachable:
 * it is in `security_events` and it is in no operator's log. Nothing failed,
 * nothing warned, and the only way to notice was to go looking for an event you
 * knew you had caused.
 *
 * Six emit sites had that shape against 53 that passed `tenantId` correctly,
 * and five of the six were the entire device family — `user.device_registered`,
 * `user.device_limit_reached`, the two `*.device_released`,
 * `end_user.device_blocked`, `end_user.device_unblocked`. The whole device audit
 * trail was therefore unreachable from the panel: an operator blocking somebody's
 * device recorded an event that appeared neither in the workspace Activity log
 * nor on the end-user it happened to.
 *
 * `recordSecurityEvent` now derives the workspace from the Application when the
 * caller names only that, so this is a property of the writer rather than a rule
 * every call site has to remember. These cases pin the property, and the last one
 * pins the real path end to end, because that is the one that regressed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordSecurityEvent } from '../src/lib/security-events.js';

interface Bootstrapped {
  tenantId: string;
  applicationId: string;
  publishableKey: string;
  tenantAccess: string;
}

describe('Security events are reachable from the workspace that owns the Application', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-sectenant-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS sectenant ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App sectenant ${slug}`, slug: `sectenant-${slug}` },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    return {
      tenantId: session.activeTenantId,
      applicationId: application.id,
      publishableKey: application.publicKey,
      tenantAccess: session.accessToken,
    };
  }

  /** Types in the workspace log for one Application, newest first. */
  async function loggedTypes(b: Bootstrapped, actorType?: string): Promise<string[]> {
    const query = new URLSearchParams({ applicationId: b.applicationId, limit: '100' });
    if (actorType) query.set('actorType', actorType);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?${query.toString()}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data.items as Array<{ type: string }>).map((e) => e.type);
  }

  it('an event recorded with only an applicationId still reaches its workspace log', async () => {
    const b = await bootstrap('derived');

    await recordSecurityEvent({
      type: 'end_user.device_blocked',
      actorType: 'operator',
      actorId: 'op-1',
      applicationId: b.applicationId,
      metadata: { deviceId: 'dev-1', endUserId: 'eu-1' },
    });

    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { applicationId: b.applicationId, type: 'end_user.device_blocked' },
    });
    expect(row.tenantId).toBe(b.tenantId);
    expect(await loggedTypes(b)).toContain('end_user.device_blocked');
  });

  it('an explicitly supplied tenantId is never overridden by the derived one', async () => {
    const b = await bootstrap('explicit');

    await recordSecurityEvent({
      type: 'end_user.device_unblocked',
      actorType: 'operator',
      tenantId: b.tenantId,
      applicationId: b.applicationId,
      metadata: {},
    });

    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { applicationId: b.applicationId, type: 'end_user.device_unblocked' },
    });
    expect(row.tenantId).toBe(b.tenantId);
  });

  it('an event with no Application at all is still recorded, with a null tenant', async () => {
    // System/deployment-level events carry neither, and must not start throwing
    // now that the writer looks something up.
    await recordSecurityEvent({ type: 'operator.sign_in_failed', actorType: 'operator' });
    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { type: 'operator.sign_in_failed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.tenantId).toBeNull();
    expect(row.applicationId).toBeNull();
  });

  it('blocking a device through the operator route lands in the workspace log', async () => {
    const b = await bootstrap('device');

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.publishableKey}` },
      payload: {
        email: 'device-owner@example.com',
        password: 'pw-one-two-three',
        device: { fingerprint: 'fp-test-0123456789abcdef', label: 'Test machine' },
      },
    });
    expect(signUp.statusCode).toBe(201);
    const endUserId = signUp.json().data.endUser.id as string;

    const devices = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${endUserId}/devices`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(devices.statusCode).toBe(200);
    const deviceId = (devices.json().data.items as Array<{ id: string }>)[0]!.id;

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${endUserId}/devices/${deviceId}/block`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { reason: 'chargeback' },
    });
    expect(blocked.statusCode).toBe(200);

    // Registration is the end-user's own event; the block is the operator's.
    // Both were unreachable before, and they arrive under different actor
    // types, which is why the panel has to scan more than one.
    expect(await loggedTypes(b, 'end_user')).toContain('user.device_registered');
    expect(await loggedTypes(b, 'operator')).toContain('end_user.device_blocked');
  });
});
