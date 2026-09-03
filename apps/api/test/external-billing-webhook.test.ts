/**
 * The external billing provider, end to end:
 * `POST /api/v1/webhooks/billing/external/:slug`.
 *
 * What is under test is the contract an operator's own billing system gets
 * when it posts what it sold. Each case asserts a consequence rather than a
 * write: the subscriber exists and is entitled, the outbound events a
 * consumer needs were emitted exactly once, a replay changed nothing, and the
 * ingress refuses what it should refuse before storing anything.
 *
 * Signatures are real: the module verifies offline HMAC, so every fixture
 * here is signed with the Application's stored secret, the same way the
 * Stripe and Razorpay suites sign theirs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebhookDelivery } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { billingService } from '../src/modules/billing/billing.service.js';
import { pickProvider } from '../src/modules/billing/providers/index.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const SECRET = 'external-billing-signing-secret-for-tests-0123456789';

/** Poll for delivery rows of one event type: emission is fire-and-forget. */
async function waitForDeliveries(
  endpointId: string,
  eventType: string,
  count: number,
  timeoutMs = 4000,
): Promise<WebhookDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.webhookDelivery.findMany({ where: { endpointId, eventType } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe('External billing provider webhook', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let appSlug: string;
  let endpointId: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `ext-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    token = (su.json().data as { accessToken: string }).accessToken;
    appSlug = `ext-${slug}`;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'ExternalApp', slug: appSlug },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    appId = (ac.json().data as { id: string }).id;
    await billingCredentialsService.upsertCredentials(
      appId,
      'external',
      { webhookSecret: SECRET },
      { mode: 'test' },
    );
    const { endpoint } = await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/external-hook',
      events: ['*'],
    });
    endpointId = endpoint.id;
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  async function makePlan(slug: string, body: Record<string, unknown> = {}): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH', ...body },
    });
    if (r.statusCode !== 201) throw new Error(`makePlan ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  async function putEntitlement(slug: string, body: Record<string, unknown>): Promise<void> {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: body,
    });
    if (r.statusCode !== 200) throw new Error(`putEntitlement ${r.statusCode}: ${r.body}`);
  }

  /** A plan with 500 credits, so entitlement is observable as a balance. */
  async function proPlan(): Promise<void> {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
  }

  function sign(
    payload: string,
    opts: { secret?: string; t?: number } = {},
  ): Record<string, string> {
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', opts.secret ?? SECRET).update(`${t}.${payload}`).digest('hex');
    return { 'content-type': 'application/json', 'x-rekey-signature': `t=${t},v1=${v1}` };
  }

  function post(
    body: unknown,
    opts: { secret?: string; t?: number; slug?: string; headers?: Record<string, string> } = {},
  ) {
    const payload = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/billing/external/${opts.slug ?? appSlug}`,
      headers: opts.headers ?? sign(payload, opts),
      payload,
    });
  }

  function event(type: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    return { eventId: `evt_${seq}_${type}`, type, occurredAt: new Date().toISOString(), data, ...extra };
  }

  function activated(
    subscriptionId: string,
    plan: string,
    subscriber: Record<string, unknown>,
    subscription: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return event('subscription.activated', {
      subscription: { id: subscriptionId, plan, ...subscription },
      subscriber,
    });
  }

  async function subscriptionOf(providerSubId: string) {
    return prisma.subscription.findUniqueOrThrow({
      where: { applicationId_providerSubId: { applicationId: appId, providerSubId } },
    });
  }

  // ------------------------------------------------------------ the ingress

  it('503 until a signing secret is saved; 401 for a missing, malformed, wrong or stale signature', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'NoSecret', slug: `${appSlug}-nosecret` },
    });
    expect(other.statusCode).toBe(201);
    const noCreds = await post(event('ping', {}), { slug: `${appSlug}-nosecret` });
    expect(noCreds.statusCode).toBe(503);
    expect(noCreds.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');

    const missing = await post(event('ping', {}), { headers: { 'content-type': 'application/json' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('WEBHOOK_SIGNATURE_MISSING');

    const malformed = await post(event('ping', {}), {
      headers: { 'content-type': 'application/json', 'x-rekey-signature': 'nonsense' },
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    const wrong = await post(event('ping', {}), { secret: 'not-the-secret-but-long-enough-to-pass-rules' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    const stale = await post(event('ping', {}), { t: Math.floor(Date.now() / 1000) - 600 });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('WEBHOOK_SIGNATURE_STALE');

    // Nothing above was stored: a refused request leaves no receipt.
    expect(await prisma.webhookEvent.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('a malformed envelope is refused with 400 and the failing path, and stored nowhere', async () => {
    const noId = await post({ type: 'ping' });
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error.code).toBe('WEBHOOK_PAYLOAD_INVALID');
    expect(noId.json().error.message).toContain('eventId');

    const noPlan = await post(
      event('subscription.activated', {
        subscription: { id: 'sub_1' },
        subscriber: { email: 'a@example.com' },
      }),
    );
    expect(noPlan.statusCode).toBe(400);
    expect(noPlan.json().error.code).toBe('WEBHOOK_PAYLOAD_INVALID');
    expect(noPlan.json().error.message).toContain('subscription.plan');

    const twoSubjects = await post(
      event('subscription.activated', {
        subscription: { id: 'sub_1', plan: 'pro' },
        subscriber: { email: 'a@example.com', endUserId: 'eu_1' },
      }),
    );
    expect(twoSubjects.statusCode).toBe(400);
    expect(twoSubjects.json().error.message).toContain('exactly one');

    expect(await prisma.webhookEvent.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('ping verifies, is logged as processed, and changes nothing', async () => {
    const res = await post(event('ping', {}));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true });
    const rows = await prisma.webhookEvent.findMany({ where: { applicationId: appId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('external');
    expect(rows[0]!.eventType).toBe('ping');
    expect(rows[0]!.processedAt).not.toBeNull();
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('an event type Rekey does not know is acknowledged and recorded, never refused', async () => {
    const res = await post(event('invoice.finalized', { anything: true }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true });
  });

  // ------------------------------------------------------------ activation

  it('activates for an unknown address: creates the end-user, binds the row, provisions, announces', async () => {
    await proPlan();
    const periodEnd = daysFromNow(30);
    const res = await post(
      activated('sub_ext_1', 'pro', { email: 'Buyer@Example.com' }, { currentPeriodEnd: periodEnd.toISOString() }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, processed: true });

    // The account exists because the billing system said so: no password,
    // default role, address trusted.
    const user = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'buyer@example.com' } },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerified).toBe(true);
    expect(user.role).toBe('user');

    const sub = await subscriptionOf('sub_ext_1');
    expect(sub.status).toBe('ACTIVE');
    expect(sub.provider).toBe('external');
    expect(sub.endUserId).toBe(user.id);
    expect(sub.currentPeriodEnd?.toISOString()).toBe(periodEnd.toISOString());
    expect((sub.metadata as { grant?: { note?: string } }).grant?.note).toContain('external event');

    // What the buyer now holds.
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(500);

    // Both announcements, once each, with the provenance a consumer needs.
    const activations = await waitForDeliveries(endpointId, 'subscription.activated', 1);
    expect(activations).toHaveLength(1);
    const created = await waitForDeliveries(endpointId, 'user.created', 1);
    expect(created).toHaveLength(1);
    expect((created[0]!.payload as { data: { via: string } }).data.via).toBe('billing:external');

    // And the trail.
    const events = await waitForSecurityEvents({
      applicationId: appId,
      type: 'end_user.created_by_billing_webhook',
    });
    expect(events[0]!.actorType).toBe('system');
    expect((events[0]!.metadata as { endUserId: string; provider: string }).endUserId).toBe(user.id);
    expect((events[0]!.metadata as { provider: string }).provider).toBe('external');
  });

  it('a subscriber named by end-user id must already exist, and is not re-created', async () => {
    await proPlan();
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email: 'known@example.com', password: 'pw-one-two-three' },
    });
    const euId = (r.json().data as { id: string }).id;

    const ok = await post(activated('sub_known', 'pro', { endUserId: euId }));
    expect(ok.statusCode).toBe(200);
    expect((await subscriptionOf('sub_known')).endUserId).toBe(euId);
    expect(await prisma.endUser.count({ where: { applicationId: appId } })).toBe(1);
    await settle();
    expect(await waitForDeliveries(endpointId, 'user.created', 1, 200)).toHaveLength(0);

    // Unknown id: refused loudly, left unprocessed so the sender retries.
    const bad = await post(activated('sub_unknown', 'pro', { endUserId: 'eu_does_not_exist' }));
    expect(bad.statusCode).toBe(500);
    const receipt = await prisma.webhookEvent.findFirst({
      where: { applicationId: appId, eventType: 'subscription.activated', processedAt: null },
    });
    expect(receipt?.processingError).toContain('eu_does_not_exist');
  });

  it('a replay of the same event id is acknowledged and applies nothing', async () => {
    await proPlan();
    const body = activated('sub_replay', 'pro', { email: 'r@example.com' });
    const first = await post(body);
    expect(first.json()).toMatchObject({ processed: true });
    const again = await post(body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ processed: false, reason: 'duplicate' });
    await settle();
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2, 200)).toHaveLength(1);
    const user = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'r@example.com' } },
    });
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(500);
  });

  it('a later period end is a renewal: the period moves, credits refill once, nothing is re-announced', async () => {
    await proPlan();
    await post(activated('sub_renew', 'pro', { email: 'n@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
    const user = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'n@example.com' } },
    });
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(500);

    const nextEnd = daysFromNow(60);
    const renewal = await post(
      activated('sub_renew', 'pro', { email: 'n@example.com' }, { currentPeriodEnd: nextEnd.toISOString() }),
    );
    expect(renewal.json()).toMatchObject({ processed: true });
    const sub = await subscriptionOf('sub_renew');
    expect(sub.currentPeriodEnd?.toISOString()).toBe(nextEnd.toISOString());
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(1000);

    // The same renewal again (a new event id, same period) grants nothing more.
    await post(activated('sub_renew', 'pro', { email: 'n@example.com' }, { currentPeriodEnd: nextEnd.toISOString() }));
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(1000);

    await settle();
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2, 200)).toHaveLength(1);
  });

  it('a period that has already ended is stale news and is ignored', async () => {
    await proPlan();
    const res = await post(
      activated('sub_stale', 'pro', { email: 's@example.com' }, { currentPeriodEnd: daysFromNow(-1).toISOString() }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: true });
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
    // Not even the subscriber: nothing about a dead period warrants an account.
    expect(await prisma.endUser.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('an unknown plan slug fails loudly and stays retryable', async () => {
    const res = await post(activated('sub_noplan', 'enterprise', { email: 'p@example.com' }));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ received: true, processed: false });
    const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId } });
    expect(receipt.processedAt).toBeNull();
    expect(receipt.processingError).toMatch(/enterprise/);
  });

  // ------------------------------------------------------------ lifecycle

  it('past_due then activated: dunning state and the outbound events mirror a hosted provider', async () => {
    await proPlan();
    await post(activated('sub_pd', 'pro', { email: 'pd@example.com' }));
    const pd = await post(event('subscription.past_due', { subscription: { id: 'sub_pd' } }));
    expect(pd.json()).toMatchObject({ processed: true });
    expect((await subscriptionOf('sub_pd')).status).toBe('PAST_DUE');
    expect(await waitForDeliveries(endpointId, 'subscription.past_due', 1)).toHaveLength(1);

    const back = await post(activated('sub_pd', 'pro', { email: 'pd@example.com' }));
    expect(back.json()).toMatchObject({ processed: true });
    expect((await subscriptionOf('sub_pd')).status).toBe('ACTIVE');
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2)).toHaveLength(2);
  });

  it('canceled with a future effectiveAt schedules; without one it cancels now; activated reopens', async () => {
    await proPlan();
    await post(activated('sub_c', 'pro', { email: 'c@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));

    const later = daysFromNow(10);
    const scheduled = await post(
      event('subscription.canceled', { subscription: { id: 'sub_c', effectiveAt: later.toISOString() } }),
    );
    expect(scheduled.json()).toMatchObject({ processed: true });
    let sub = await subscriptionOf('sub_c');
    expect(sub.status).toBe('ACTIVE');
    expect(sub.cancelAt?.toISOString()).toBe(later.toISOString());
    await settle();
    expect(await waitForDeliveries(endpointId, 'subscription.canceled', 1, 200)).toHaveLength(0);

    // A term beyond the scheduled end says the subscription continues.
    await post(activated('sub_c', 'pro', { email: 'c@example.com' }, { currentPeriodEnd: daysFromNow(40).toISOString() }));
    sub = await subscriptionOf('sub_c');
    expect(sub.cancelAt).toBeNull();

    const now = await post(event('subscription.canceled', { subscription: { id: 'sub_c' } }));
    expect(now.json()).toMatchObject({ processed: true });
    sub = await subscriptionOf('sub_c');
    expect(sub.status).toBe('CANCELED');
    expect(sub.canceledAt).not.toBeNull();
    expect(await waitForDeliveries(endpointId, 'subscription.canceled', 1)).toHaveLength(1);

    // The buyer came back: the grant path reopens the terminal row.
    const again = await post(activated('sub_c', 'pro', { email: 'c@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
    expect(again.json()).toMatchObject({ processed: true });
    sub = await subscriptionOf('sub_c');
    expect(sub.status).toBe('ACTIVE');
    expect(sub.canceledAt).toBeNull();
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2)).toHaveLength(2);
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(1);
  });

  it('the same subscription id on a different plan is a plan change: the old row is retired', async () => {
    await proPlan();
    await makePlan('team');
    await putEntitlement('team', { kind: 'CREDIT', quantity: 2000 });
    await post(activated('sub_pc', 'pro', { email: 'pc@example.com' }));
    const user = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'pc@example.com' } },
    });

    const switched = await post(activated('sub_pc', 'team', { email: 'pc@example.com' }));
    expect(switched.json()).toMatchObject({ processed: true });

    const rows = await prisma.subscription.findMany({
      where: { applicationId: appId, endUserId: user.id },
      include: { plan: true },
    });
    const pro = rows.find((r) => r.plan.slug === 'pro')!;
    const team = rows.find((r) => r.plan.slug === 'team')!;
    expect(pro.status).toBe('CANCELED');
    expect(pro.providerSubId).toBeNull();
    expect((pro.metadata as { replacedBy?: { planSlug: string } }).replacedBy?.planSlug).toBe('team');
    expect(team.status).toBe('ACTIVE');
    expect(team.providerSubId).toBe('sub_pc');
    expect(await waitForDeliveries(endpointId, 'subscription.canceled', 1)).toHaveLength(1);
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2)).toHaveLength(2);
    expect(await creditsService.getBalance(appId, { endUserId: user.id })).toBe(2500);
  });

  it('payments are recorded against the subscription and can be marked refunded', async () => {
    await proPlan();
    await post(activated('sub_pay', 'pro', { email: 'pay@example.com' }));
    const paid = await post(
      event('payment.succeeded', {
        payment: { id: 'pay_1', subscriptionId: 'sub_pay', amount: 2900, currency: 'usd', description: 'Pro, September' },
      }),
    );
    expect(paid.json()).toMatchObject({ processed: true });
    const sub = await subscriptionOf('sub_pay');
    const payment = await prisma.payment.findFirstOrThrow({
      where: { applicationId: appId, providerPaymentId: 'pay_1' },
    });
    expect(payment.subscriptionId).toBe(sub.id);
    expect(payment.status).toBe('SUCCEEDED');
    expect(payment.amount).toBe(2900);
    expect(payment.currency).toBe('USD');
    expect(await waitForDeliveries(endpointId, 'payment.succeeded', 1)).toHaveLength(1);

    const refunded = await post(
      event('payment.refunded', {
        payment: { id: 'pay_1', subscriptionId: 'sub_pay', amount: 2900, currency: 'usd' },
      }),
    );
    expect(refunded.json()).toMatchObject({ processed: true });
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { applicationId: appId, providerPaymentId: 'pay_1' } })).status,
    ).toBe('REFUNDED');

    // Money that moved is a fact even when Rekey holds no subscription for
    // it: the charge is recorded unlinked, so it reaches the operator's
    // unapplied-payments queue instead of vanishing. Same posture as every
    // hosted provider.
    await post(
      event('payment.succeeded', {
        payment: { id: 'pay_stray', subscriptionId: 'sub_never_seen', amount: 100, currency: 'usd' },
      }),
    );
    const stray = await prisma.payment.findFirstOrThrow({
      where: { applicationId: appId, providerPaymentId: 'pay_stray' },
    });
    expect(stray.subscriptionId).toBeNull();
    expect(stray.status).toBe('SUCCEEDED');

    // A failure for an unknown subscription buys nothing and is skipped.
    await post(
      event('payment.failed', {
        payment: { id: 'pay_stray_fail', subscriptionId: 'sub_never_seen', amount: 100, currency: 'usd' },
      }),
    );
    expect(
      await prisma.payment.count({ where: { applicationId: appId, providerPaymentId: 'pay_stray_fail' } }),
    ).toBe(0);
  });

  // ------------------------------------------------------------ the boundary

  it('is inbound only: never routed to, not listed for checkout, and refuses to cancel', async () => {
    await proPlan();
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });

    // Configured and enabled, yet not a place to send a buyer.
    expect((await billingCredentialsService.listEnabled(appId)).map((p) => p.provider)).toEqual(['external']);
    expect(await billingCredentialsService.listCheckoutEnabled(appId)).toEqual([]);
    await expect(pickProvider({ application })).rejects.toMatchObject({
      code: 'BILLING_CREDENTIALS_NOT_CONFIGURED',
    });

    // The plan list says why a Buy button would be refused.
    const plans = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
    });
    const pro = (plans.json().data.items as Array<{ slug: string; checkout?: { ready: boolean; blockers: Array<{ provider: string | null; code: string }> } }>).find(
      (p) => p.slug === 'pro',
    )!;
    expect(pro.checkout?.ready).toBe(false);
    expect(pro.checkout?.blockers).toEqual([
      expect.objectContaining({ provider: 'external', code: 'PROVIDER_INBOUND_ONLY' }),
    ]);

    // Discovery tells the panel what kind of provider this is.
    const discovery = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/billing/providers`,
      headers: auth(),
    });
    const external = (discovery.json().data.providers as Array<{
      name: string;
      configured: boolean;
      capabilities: { checkout?: boolean };
      status: { webhookConfigured: boolean } | null;
      credentialFields: Array<{ key: string; secret: boolean }>;
    }>).find((p) => p.name === 'external')!;
    expect(external.capabilities.checkout).toBe(false);
    expect(external.configured).toBe(true);
    expect(external.status?.webhookConfigured).toBe(true);
    expect(external.credentialFields).toEqual([expect.objectContaining({ key: 'webhookSecret', secret: true })]);

    // The money lives elsewhere, so a cancel through Rekey is refused with
    // the repair, and the row is untouched.
    await post(activated('sub_cancel_me', 'pro', { email: 'cm@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
    const user = await prisma.endUser.findUniqueOrThrow({
      where: { applicationId_email: { applicationId: appId, email: 'cm@example.com' } },
    });
    await expect(billingService.cancelCurrentSubscription(application, user)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_MANAGED_EXTERNALLY',
    });
    expect((await subscriptionOf('sub_cancel_me')).status).toBe('ACTIVE');
  });

  it('a scheduled cancellation leaves a PAST_DUE row past due; the date, not an invented status, is mirrored', async () => {
    await proPlan();
    await post(activated('sub_sched', 'pro', { email: 'sched@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
    await post(event('subscription.past_due', { subscription: { id: 'sub_sched' } }));
    expect((await subscriptionOf('sub_sched')).status).toBe('PAST_DUE');

    const later = daysFromNow(10);
    const res = await post(
      event('subscription.canceled', { subscription: { id: 'sub_sched', effectiveAt: later.toISOString() } }),
    );
    expect(res.json()).toMatchObject({ processed: true });
    const sub = await subscriptionOf('sub_sched');
    expect(sub.status).toBe('PAST_DUE');
    expect(sub.cancelAt?.toISOString()).toBe(later.toISOString());
    await settle();
    // No reactivation was announced: the only activation is the first one.
    expect(await waitForDeliveries(endpointId, 'subscription.activated', 2, 200)).toHaveLength(1);
  });

  it('never rebinds a live subscription that a hosted provider created', async () => {
    await proPlan();
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email: 'stripe-user@example.com', password: 'pw-one-two-three' },
    });
    const euId = (r.json().data as { id: string }).id;
    const plan = await prisma.plan.findUniqueOrThrow({ where: { applicationId_slug: { applicationId: appId, slug: 'pro' } } });
    const stripeRow = await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: euId,
        planId: plan.id,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_stripe_live',
        currentPeriodEnd: daysFromNow(20),
      },
    });

    const res = await post(activated('sub_ext_clash', 'pro', { endUserId: euId }, { currentPeriodEnd: daysFromNow(40).toISOString() }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ processed: true });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: stripeRow.id } });
    expect(after.provider).toBe('stripe');
    expect(after.providerSubId).toBe('sub_stripe_live');
    expect(after.currentPeriodEnd?.toISOString()).toBe(stripeRow.currentPeriodEnd?.toISOString());
    const refused = (after.metadata as { refusedGrants?: Array<{ providerSubId: string }> }).refusedGrants;
    expect(refused?.map((g) => g.providerSubId)).toEqual(['sub_ext_clash']);
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(1);
  });

  it('a period end only ever moves forward, and null never clears a term', async () => {
    await proPlan();
    const far = daysFromNow(60);
    await post(activated('sub_fwd', 'pro', { email: 'fwd@example.com' }, { currentPeriodEnd: far.toISOString() }));
    await post(activated('sub_fwd', 'pro', { email: 'fwd@example.com' }, { currentPeriodEnd: daysFromNow(30).toISOString() }));
    expect((await subscriptionOf('sub_fwd')).currentPeriodEnd?.toISOString()).toBe(far.toISOString());
    await post(activated('sub_fwd', 'pro', { email: 'fwd@example.com' }, { currentPeriodEnd: null }));
    expect((await subscriptionOf('sub_fwd')).currentPeriodEnd?.toISOString()).toBe(far.toISOString());
  });

  it('an Application that bills per organization refuses an activation naming none, before anything is written', async () => {
    await proPlan();
    const cfg = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/billing-config`,
      headers: auth(),
      payload: { billingSubject: 'org' },
    });
    expect(cfg.statusCode).toBe(200);
    const res = await post(activated('sub_org', 'pro', { email: 'org-buyer@example.com' }));
    expect(res.statusCode).toBe(500);
    const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId, eventType: 'subscription.activated' } });
    expect(receipt.processingError).toContain('organization');
    // Nothing was created for an event that could never have activated.
    expect(await prisma.endUser.count({ where: { applicationId: appId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('an erased subscriber is refused', async () => {
    await proPlan();
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email: 'gone@example.com', password: 'pw-one-two-three' },
    });
    const euId = (r.json().data as { id: string }).id;
    await prisma.endUser.update({ where: { id: euId }, data: { erasedAt: new Date() } });
    const res = await post(activated('sub_gone', 'pro', { endUserId: euId }));
    expect(res.statusCode).toBe(500);
    const receipt = await prisma.webhookEvent.findFirstOrThrow({ where: { applicationId: appId } });
    expect(receipt.processingError).toContain('erased');
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('the signing secret has a length floor and the credential is never echoed', async () => {
    const short = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/billing-credentials/external`,
      headers: auth(),
      payload: { data: { webhookSecret: 'too-short' } },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('BILLING_CREDENTIALS_INVALID');

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/billing-credentials/external`,
      headers: auth(),
      payload: { data: { webhookSecret: 'rotated-secret-that-is-long-enough-0123456789' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json())).not.toContain('rotated-secret');

    // The old secret no longer signs; the new one does.
    const old = await post(event('ping', {}));
    expect(old.statusCode).toBe(401);
    const fresh = await post(event('ping', {}), { secret: 'rotated-secret-that-is-long-enough-0123456789' });
    expect(fresh.statusCode).toBe(200);
  });
});
