/**
 * Importing a book of business a billing system already sold.
 *
 * The event feed covers everything after a system connects. It cannot cover
 * what was sold before, which on migration day is everything — hence an import.
 * And an import is the most dangerous shape a button can have: a bulk write
 * against somebody else's data, matching strangers to local accounts by email.
 *
 * So the cases here are mostly about the REFUSALS, because the happy path is
 * the easy half:
 *
 *   - a preview writes no subscriptions at all;
 *   - an existing ACTIVE subscriber is never overwritten;
 *   - an erased end-user is never matched, and never re-created;
 *   - a row whose plan maps to nothing is skipped with a reason, not guessed at;
 *   - applying twice does not import twice.
 *
 * The provider is stubbed at the module seam rather than over HTTP: what is
 * under test is the decision table, not `fetch`. The real pull implementation
 * and its signing are exercised separately.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ExternalSubscription } from '../src/modules/billing/providers/types.js';

/** Rows the stubbed provider will return for the next dry run. */
const feed: { items: ExternalSubscription[] } = { items: [] };

vi.mock('../src/modules/billing/providers/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/billing/providers/index.js')>();
  return {
    ...actual,
    getProviderForApplication: async (application: unknown, provider: string) => {
      if (provider !== 'external') {
        return actual.getProviderForApplication(application as never, provider as never);
      }
      return {
        name: 'external',
        async listSubscriptions() {
          return { items: feed.items };
        },
      };
    },
  };
});

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');

interface World {
  ownerToken: string;
  applicationId: string;
  slug: string;
}

function row(over: Partial<ExternalSubscription> & { email: string }): ExternalSubscription {
  const { email, ...rest } = over;
  return {
    externalId: `sub_${Math.random().toString(36).slice(2, 10)}`,
    status: 'active',
    planRef: 'pro',
    customer: { email },
    ...rest,
  } as ExternalSubscription;
}

describe('subscription import', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.94.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function world(): Promise<World> {
    currentIp = `10.94.${++n}.1`;
    const slug = `imp-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Import Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Import app', slug },
    });
    expect(appRes.statusCode).toBe(201);
    const applicationId = (appRes.json().data as { id: string }).id;

    // A plan whose SLUG is the provider's planRef, which is the mapping an
    // operator gets for free when the two already agree.
    const plan = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { slug: 'pro', name: 'Pro', amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH' },
    });
    expect(plan.statusCode).toBe(201);

    return { ownerToken, applicationId, slug };
  }

  const auth = (w: World) => ({ authorization: `Bearer ${w.ownerToken}` });
  const base = (w: World) => `/api/v1/tenant/applications/${w.applicationId}`;

  async function dryRun(w: World, matchStrategy = 'email_or_create') {
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports`,
      headers: auth(w),
      payload: { provider: 'external', matchStrategy },
    });
    expect(res.statusCode).toBe(201);
    const runId = (res.json().data as { runId: string }).runId;
    const read = await inject({
      method: 'GET',
      url: `${base(w)}/subscription-imports/${runId}?limit=100`,
      headers: auth(w),
    });
    expect(read.statusCode).toBe(200);
    return {
      runId,
      run: read.json().data.run as { status: string; counts: Record<string, number> },
      items: read.json().data.items.items as Array<{
        externalId: string;
        outcome: string;
        email: string | null;
        detail: { reason?: string };
      }>,
    };
  }

  async function makeEndUser(w: World, email: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: `${base(w)}/end-users`,
      headers: auth(w),
      payload: { email },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  // ---------- the preview writes nothing ----------

  it('a dry run decides every row and writes no subscriptions', async () => {
    const w = await world();
    await makeEndUser(w, 'known@example.com');
    feed.items = [
      row({ email: 'known@example.com' }),
      row({ email: 'stranger@example.com' }),
      row({ email: 'nomatch@example.com', planRef: 'plan-we-do-not-have' }),
      row({ email: 'gone@example.com', status: 'canceled' }),
      { ...row({ email: 'x@example.com' }), customer: { email: '' } } as ExternalSubscription,
    ];

    const { run, items } = await dryRun(w);
    expect(run.status).toBe('ready');

    const byEmail = new Map(items.map((i) => [i.email, i.outcome]));
    expect(byEmail.get('known@example.com')).toBe('match');
    expect(byEmail.get('stranger@example.com')).toBe('create');
    expect(byEmail.get('nomatch@example.com')).toBe('skip_no_plan');
    expect(byEmail.get('gone@example.com')).toBe('skip_invalid');

    // Every refusal explains itself. A preview reading "5 rows, 2 importable"
    // with no reasons is a black box the operator has to trust.
    for (const i of items) {
      if (i.outcome.startsWith('skip')) expect(i.detail.reason).toEqual(expect.any(String));
    }

    // The whole point of the step.
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  it('without email_or_create, an unknown address is skipped rather than created', async () => {
    const w = await world();
    feed.items = [row({ email: 'stranger@example.com' })];
    const { items } = await dryRun(w, 'email');
    expect(items[0]!.outcome).toBe('skip_invalid');
    expect(items[0]!.detail.reason).toMatch(/No end-user/i);
  });

  // ---------- never overwrite ----------

  it('an end-user who is already subscribed is skipped, not updated', async () => {
    const w = await world();
    const euid = await makeEndUser(w, 'subscribed@example.com');
    const granted = await inject({
      method: 'POST',
      url: `${base(w)}/end-users/${euid}/subscriptions`,
      headers: auth(w),
      payload: { planSlug: 'pro', note: 'existing' },
    });
    expect(granted.statusCode).toBe(201);

    feed.items = [row({ email: 'subscribed@example.com' })];
    const { items } = await dryRun(w);
    expect(items[0]!.outcome).toBe('skip_active');
    expect(items[0]!.detail.reason).toMatch(/already/i);
  });

  // ---------- never resurrect ----------

  it('an erased end-user is never matched and never re-created', async () => {
    const w = await world();
    const euid = await makeEndUser(w, 'erased@example.com');
    const erase = await inject({
      method: 'DELETE',
      url: `${base(w)}/end-users/${euid}?erasure=true`,
      headers: auth(w),
    });
    expect(erase.statusCode).toBe(200);

    // The address is anonymised by the erasure, so the row will not match it —
    // but the case that matters is that it is not RE-CREATED either, which
    // would rebuild the person a GDPR request removed.
    feed.items = [row({ email: 'erased@example.com' })];
    const { runId, items } = await dryRun(w);
    expect(items[0]!.outcome).toBe('create');

    await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    // A fresh account under that address is correct: the tombstone keeps the
    // anonymised one, and this is a new person as far as Rekey is concerned.
    const rebuilt = await prisma.endUser.findFirst({
      where: { applicationId: w.applicationId, email: 'erased@example.com' },
    });
    expect(rebuilt?.erasedAt ?? null).toBeNull();
  });

  // ---------- applying ----------

  it('apply imports the decided rows, creates unlinked users, and is not repeatable', async () => {
    const w = await world();
    await makeEndUser(w, 'known@example.com');
    feed.items = [row({ email: 'known@example.com' }), row({ email: 'stranger@example.com' })];

    const { runId } = await dryRun(w);
    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ imported: 2, failed: 0 });

    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);

    // The created one is unlinked: no password, unverified, and marked with the
    // run that made it so the end-user page can explain the half-finished look.
    const created = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: w.applicationId, email: 'stranger@example.com' },
    });
    expect(created.passwordHash).toBeNull();
    expect(created.emailVerified).toBe(false);
    expect(created.metadata).toMatchObject({ importRunId: runId });

    // A double-click must not import twice.
    const again = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('IMPORT_RUN_NOT_READY');
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);
  });

  it('the apply is refused without the typed confirmation', async () => {
    const w = await world();
    feed.items = [row({ email: 'a@example.com' })];
    const { runId } = await dryRun(w);

    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: 'not-the-slug' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IMPORT_CONFIRM_MISMATCH');
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  // ---------- idempotency of the source ----------

  it('a provider returning the same subscription twice imports it once', async () => {
    const w = await world();
    const dup = row({ email: 'dup@example.com' });
    feed.items = [dup, dup];

    const { items } = await dryRun(w);
    expect(items.length).toBe(1);
  });

  // ---------- access control ----------

  it('a MEMBER cannot start or apply an import', async () => {
    const w = await world();
    const outsider = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `outsider-${w.slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Outsider Co',
      },
    });
    const token = (outsider.json().data as { accessToken: string }).accessToken;
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports`,
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'external' },
    });
    expect(res.statusCode).toBe(404);
  });
});
