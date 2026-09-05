/**
 * Turning email off, and what that must NOT do.
 *
 * `dispatch` had no gate at all before this: an Application with a transport
 * configured sent everything it was asked to send, and nothing could stop it —
 * not globally, not per event, not for one address. A product whose own backend
 * already sends transactional mail therefore delivered two of everything.
 *
 * The three gates are easy. The two things worth testing hard are the ways a
 * naive implementation of them goes wrong:
 *
 *   1. **A suppression must not become a token disclosure.** `no_transport` is
 *      the documented contract that hands a RAW reset token back to the API
 *      caller so a self-hoster can deliver it. If a suppressed send reported
 *      itself that way, "we turned email off" would quietly mean "the API now
 *      returns live password-reset tokens in its responses".
 *   2. **Disabling an essential event must be refused, not merely warned about.**
 *      Switching off `password_reset` while password sign-in is live removes the
 *      only way a user who forgets their password gets back in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';

interface World {
  ownerToken: string;
  applicationId: string;
  publishableKey: string;
  tag: string;
}

describe('email send control', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.95.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function world(): Promise<World> {
    currentIp = `10.95.${++n}.1`;
    const tag = `mail-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${tag}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Mail Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Mail app', slug: tag },
    });
    expect(appRes.statusCode).toBe(201);
    const application = appRes.json().data as { id: string; publicKey: string };
    return { ownerToken, applicationId: application.id, publishableKey: application.publicKey, tag };
  }

  const auth = (w: World) => ({ authorization: `Bearer ${w.ownerToken}` });
  const base = (w: World) => `/api/v1/tenant/applications/${w.applicationId}`;

  async function makeEndUser(w: World, email: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: `${base(w)}/end-users`,
      headers: auth(w),
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  /** Dispatch straight through the service, so the gate is what is under test. */
  async function send(w: World, to: string) {
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: w.applicationId },
    });
    return emailService.dispatch({
      application,
      eventKey: 'welcome',
      to,
      variables: { userEmail: to, appUrl: 'https://app.example.com' },
    });
  }

  // ---------- the three gates ----------

  it('defaults to enabled, and nothing is suppressed until somebody says so', async () => {
    const w = await world();
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { emailsEnabled: boolean; events: Array<{ enabled: boolean }> };
    expect(data.emailsEnabled).toBe(true);
    expect(data.events.length).toBe(9);
    expect(data.events.every((e) => e.enabled)).toBe(true);
  });

  it('the master switch suppresses a send, and records it as suppressed', async () => {
    const w = await world();
    const patch = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const outcome = await send(w, 'someone@example.com');
    expect(outcome.kind).toBe('error');

    // Recorded, not silently dropped: "why did they not get it" has to be
    // answerable in the one place an operator looks for send outcomes.
    const log = await prisma.emailLog.findFirstOrThrow({
      where: { applicationId: w.applicationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.status).toBe('suppressed');
    expect(log.error).toContain('switched off');
  });

  it('a disabled event suppresses only that event', async () => {
    const w = await world();
    const off = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/welcome`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);

    expect((await send(w, 'a@example.com')).kind).toBe('error');

    // A different event is untouched. No transport is configured in test, so
    // the honest outcome for an allowed send is `no_transport` — which is
    // exactly what distinguishes "not sent because we cannot" from "not sent
    // because you said not to".
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: w.applicationId },
    });
    const other = await emailService.dispatch({
      application,
      eventKey: 'mfa_enabled',
      to: 'a@example.com',
      variables: { userEmail: 'a@example.com', enabledAtIso: new Date().toISOString() },
    });
    expect(other.kind).toBe('no_transport');
  });

  it('a suppressed address is refused while everyone else is not', async () => {
    const w = await world();
    const add = await inject({
      method: 'POST',
      url: `${base(w)}/email-suppressions`,
      headers: auth(w),
      payload: { address: 'Bounced@Example.com', reason: 'bounce', note: 'hard bounce' },
    });
    expect(add.statusCode).toBe(201);
    // Stored lowercased, so the unique index is a real guarantee and the
    // lookup in `dispatch` cannot miss on casing.
    expect(add.json().data.address).toBe('bounced@example.com');

    expect((await send(w, 'BOUNCED@example.com')).kind).toBe('error');
    expect((await send(w, 'fine@example.com')).kind).toBe('no_transport');

    const removed = await inject({
      method: 'DELETE',
      url: `${base(w)}/email-suppressions/bounced@example.com`,
      headers: auth(w),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.removed).toBe(true);
    expect((await send(w, 'bounced@example.com')).kind).toBe('no_transport');

    // Idempotent.
    const again = await inject({
      method: 'DELETE',
      url: `${base(w)}/email-suppressions/bounced@example.com`,
      headers: auth(w),
    });
    expect(again.json().data.removed).toBe(false);
  });

  // ---------- the token-disclosure trap ----------

  it('turning email off does NOT start returning raw reset tokens', async () => {
    // The whole reason a suppression reports as `error` rather than
    // `no_transport`. With no transport configured, the reset path deliberately
    // hands the raw token back so a self-hoster can deliver it themselves. If
    // suppression took that branch, switching email off would silently turn the
    // API into a token dispenser.
    const w = await world();
    await makeEndUser(w, 'reset-me@example.com');

    // A SECRET key, deliberately: a publishable caller is given a constant
    // response that hides everything, so it could never observe this either
    // way. The secret-key caller is the one the no-transport contract hands
    // the token to, which makes it the one at risk.
    const key = await inject({
      method: 'POST',
      url: `${base(w)}/api-keys`,
      headers: auth(w),
      payload: { name: 'test', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);
    const secret = (key.json().data as { rawKey: string }).rawKey;

    const forgot = () =>
      inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${secret}` },
        payload: { email: 'reset-me@example.com' },
      });

    // Baseline: no transport is configured in test, so the documented contract
    // applies and the caller really is handed a live token to deliver.
    const before = await forgot();
    expect(before.statusCode).toBe(200);
    expect(before.json().data.resetToken).toEqual(expect.any(String));

    await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });

    // And now the point: same caller, same route, email switched off. The token
    // must be withheld. If this ever returns a string again, turning email off
    // has silently become a token dispenser.
    const after = await forgot();
    expect(after.statusCode).toBe(200);
    expect(after.json().data.resetToken).toBeNull();
  });

  // ---------- essential events are coupled to the auth config ----------

  it('refuses to disable the password-reset email while password sign-in is live', async () => {
    const w = await world();
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/password_reset`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG');
    // The refusal has to name the thing to change, or it is just a wall.
    expect(res.json().error.fix).toMatch(/password sign-in/i);
  });

  it('allows it once password sign-in is actually turned off', async () => {
    const w = await world();
    const patched = await inject({
      method: 'PATCH',
      url: `${base(w)}/auth-config`,
      headers: auth(w),
      payload: { methods: ['magic_link'] },
    });
    expect(patched.statusCode).toBe(200);

    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/password_reset`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    // And the magic-link mail is now the one that cannot be disabled.
    const blocked = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/magic_link_signin`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(blocked.statusCode).toBe(409);
  });

  it('reports which events are blocked, and why, without being asked to change them', async () => {
    const w = await world();
    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
    });
    const events = res.json().data.events as Array<{
      key: string;
      essentialBlocker: { code: string } | null;
    }>;
    const blocked = events.filter((e) => e.essentialBlocker !== null).map((e) => e.key);
    // Password sign-in is on by default; verification is not required by
    // default; magic link is not enabled by default.
    expect(blocked).toContain('password_reset');
    expect(events.find((e) => e.key === 'welcome')?.essentialBlocker).toBeNull();
  });

  // ---------- an unknown event is a 404, not a 500 ----------

  it('an unknown event key is refused as not-found', async () => {
    const w = await world();
    const res = await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control/not_a_real_event`,
      headers: auth(w),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EMAIL_EVENT_UNKNOWN');
  });

  // ---------- stats ----------

  it('counts a suppressed send as suppressed, not as an error', async () => {
    const w = await world();
    await inject({
      method: 'PATCH',
      url: `${base(w)}/email-send-control`,
      headers: auth(w),
      payload: { emailsEnabled: false },
    });
    await send(w, 'x@example.com');

    const res = await inject({
      method: 'GET',
      url: `${base(w)}/email-stats?hours=24`,
      headers: auth(w),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json().data as { suppressed: number; error: number };
    expect(stats.suppressed).toBe(1);
    expect(stats.error).toBe(0);
  });
});
