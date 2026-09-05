/**
 * Subscription import — reading what a billing system already sold.
 *
 * ## Why this is a run, not a call
 *
 * The event feed covers everything from the moment a billing system connects.
 * It cannot cover what was sold BEFORE that, which on migration day is the
 * entire book of business. So there is an import — and an import is the most
 * dangerous shape a button can have: a bulk write against somebody else's data,
 * matching strangers to local accounts by email, decided in one click.
 *
 * So it is two steps. A DRY RUN reads the provider and records, per row, what
 * WOULD happen and why. Nothing is written to `subscriptions`. The operator
 * reads that, fixes the plan mapping, and applies — or does not. The preview is
 * the feature; the write is the easy part.
 *
 * ## What "already imported" means
 *
 * `externalId` is the idempotency key. Re-running an import never creates a
 * second subscription for the same provider subscription, because the apply
 * goes through `subscriptionGrantsService.grantSubscription`, which is itself
 * idempotent on (application, end-user, plan) and returns `activated: false`
 * for a subscriber who is already entitled.
 *
 * ## What it deliberately does not do
 *
 * It does not overwrite. A local subscriber who is already ACTIVE is
 * `skip_active`, never "updated to match the provider" — an import is for
 * subscriptions Rekey does not have, and silently rewriting live entitlement
 * from a file somebody uploaded is how a customer loses access.
 *
 * It does not resurrect. An erased end-user is never matched: their address is
 * anonymised, and matching a tombstone would rebuild the person a GDPR request
 * removed.
 */

import type { Application, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { getProviderForApplication } from './providers/index.js';
import type { ExternalSubscription } from './providers/types.js';
import type { BillingProviderName } from './credentials.service.js';
import { subscriptionGrantsService } from './grant.service.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { applicationRolesService } from '../application-roles/application-roles.service.js';
import { emitDetached, kickDeliveries } from '../webhooks/webhook.service.js';
import { assertMetadataWithinLimit } from '../../lib/metadata-limit.js';
import { assertEndUserQuota } from '../../lib/tenant-limits.js';
import { entitlementOverridesService } from './entitlement-overrides.service.js';
import { entitlementsService } from './entitlements.service.js';

/** How a row was decided. Mirrors the panel's preview groups exactly. */
export type ImportOutcome =
  | 'match'
  | 'create'
  | 'skip_no_plan'
  | 'skip_active'
  | 'skip_invalid'
  | 'error';

export type MatchStrategy = 'email' | 'email_or_create';

const PAGE_SIZE = 200;
const MAX_ROWS = 10_000;

/**
 * The metadata keys a provider registration owns.
 *
 * Mirrors `PROVIDER_METADATA_KEYS` in plans.service.ts, which is what
 * `stripProviderMetadata` reserves. Everything outside this set is operator
 * free-text and must not be read as a provider plan reference.
 */
const PROVIDER_METADATA_KEYS = ['stripe', 'paypal', 'razorpay'] as const;

const LIVE_STATUSES = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING']);
const IMPORTABLE_STATUSES = new Set(['active', 'trialing', 'past_due']);

interface PlannedItem {
  externalId: string;
  email: string | null;
  planRef: string | null;
  outcome: ImportOutcome;
  endUserId: string | null;
  planSlug: string | null;
  detail: Record<string, unknown>;
  /**
   * The terms the provider reported, carried through to the grant.
   *
   * These were typed and documented before they were threaded, which meant
   * every imported subscription silently came out open-ended and single-seat
   * regardless of what the provider said — the exact opposite of what
   * `docs/external-billing-pull.md` promises about `currentPeriodEnd`.
   */
  terms: {
    currentPeriodEnd?: string | undefined;
    startedAt?: string | undefined;
    cancelAt?: string | undefined;
    quantity?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
    customerExternalId?: string | undefined;
    customerName?: string | undefined;
  };
}

/**
 * Decide what would happen to one provider row.
 *
 * Every refusal is named rather than dropped: an operator looking at a preview
 * that says "412 rows, 30 imported" needs to know what the other 382 were, or
 * the import is a black box they have to trust.
 */
async function planRow(
  application: Application,
  raw: ExternalSubscription,
  strategy: MatchStrategy,
  planByRef: Map<string, string>,
): Promise<PlannedItem> {
  const externalId = typeof raw?.externalId === 'string' ? raw.externalId : '';
  const email = typeof raw?.customer?.email === 'string' ? raw.customer.email.toLowerCase() : null;
  const planRef = typeof raw?.planRef === 'string' ? raw.planRef : null;
  const terms = {
    ...(typeof raw?.currentPeriodEnd === 'string' && { currentPeriodEnd: raw.currentPeriodEnd }),
    ...(typeof raw?.startedAt === 'string' && { startedAt: raw.startedAt }),
    ...(typeof raw?.cancelAt === 'string' && { cancelAt: raw.cancelAt }),
    ...(typeof raw?.quantity === 'number' && { quantity: raw.quantity }),
    ...(raw?.metadata !== undefined && { metadata: raw.metadata }),
    ...(typeof raw?.customer?.externalId === 'string' && {
      customerExternalId: raw.customer.externalId,
    }),
    ...(typeof raw?.customer?.name === 'string' && { customerName: raw.customer.name }),
  };
  const base = { externalId, email, planRef, endUserId: null, planSlug: null, terms };

  if (externalId === '') {
    return { ...base, outcome: 'skip_invalid', detail: { reason: 'No externalId on the row.' } };
  }
  if (email === null || !email.includes('@')) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: { reason: 'No usable customer.email, so there is nothing to match on.' },
    };
  }
  if (typeof raw.status !== 'string' || !IMPORTABLE_STATUSES.has(raw.status)) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: {
        reason: `Status "${String(raw.status)}" is not one Rekey imports.`,
        // Canceled and expired are valid statuses and deliberately not
        // imported: there is no entitlement to grant, and creating a canceled
        // subscription would only add noise to the customer's history.
        hint: 'Only active, trialing and past_due carry entitlement worth importing.',
      },
    };
  }

  const planSlug = planRef === null ? undefined : planByRef.get(planRef);
  if (planSlug === undefined) {
    return {
      ...base,
      outcome: 'skip_no_plan',
      detail: {
        reason:
          planRef === null
            ? 'The row names no plan.'
            : `No local plan is mapped to "${planRef}".`,
        hint: 'Map it to a plan and run the import again.',
      },
    };
  }

  const existing = await prisma.endUser.findUnique({
    where: { applicationId_email: { applicationId: application.id, email } },
    select: { id: true, erasedAt: true },
  });

  // A tombstone is not a match. Their address is anonymised and matching one
  // would rebuild the person a GDPR request removed.
  if (existing && existing.erasedAt === null) {
    const live = await prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        endUserId: existing.id,
        status: { in: [...LIVE_STATUSES] as never },
      },
      select: { id: true, status: true },
    });
    if (live) {
      return {
        ...base,
        outcome: 'skip_active',
        endUserId: existing.id,
        planSlug,
        detail: {
          reason: `Already has a ${live.status} subscription in Rekey.`,
          hint: 'An import never overwrites live entitlement.',
        },
      };
    }
    return { ...base, outcome: 'match', endUserId: existing.id, planSlug, detail: {} };
  }

  if (strategy !== 'email_or_create') {
    return {
      ...base,
      outcome: 'skip_invalid',
      planSlug,
      detail: {
        reason: existing ? 'That end-user was erased.' : 'No end-user in Rekey with that address.',
        hint: existing
          ? 'An erasure cannot be undone.'
          : 'Re-run with "create missing users" to bring them in.',
      },
    };
  }
  if (existing) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: { reason: 'That end-user was erased; nothing can be granted to a tombstone.' },
    };
  }
  return { ...base, outcome: 'create', planSlug, detail: {} };
}

/**
 * Parse a date a third party wrote, refusing anything that is not a real one.
 *
 * A period end in the PAST is dropped rather than honoured: `grantSubscription`
 * refuses a subscription born already expired, and one bad row must not fail an
 * import when open-ended is the safe reading of "we could not tell".
 */
function futureDate(v: unknown, now: Date): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) return undefined;
  return d;
}

/**
 * Move a run out of `applying` when something threw that the per-row handler
 * could not absorb. Best-effort: if even this write fails there is nothing
 * further to try, and re-throwing it would mask the original cause.
 */
async function markRunFailed(runId: string, err: unknown): Promise<void> {
  await prisma.subscriptionImportRun
    .update({
      where: { id: runId },
      data: {
        status: 'failed',
        error: `Apply aborted: ${(err as Error).message}`.slice(0, 500),
        completedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

function tally(items: PlannedItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, i) => {
    acc[i.outcome] = (acc[i.outcome] ?? 0) + 1;
    return acc;
  }, {});
}

export const subscriptionImportService = {
  /**
   * Read the provider and record what WOULD happen. Writes nothing to
   * `subscriptions` — the whole point of the step.
   */
  async dryRun(args: {
    application: Application;
    provider: BillingProviderName;
    matchStrategy: MatchStrategy;
    startedBy: string;
  }): Promise<{ runId: string }> {
    const impl = await getProviderForApplication(args.application, args.provider);
    if (typeof impl.listSubscriptions !== 'function') {
      throw new RekeyError({
        statusCode: 400,
        code: 'PROVIDER_CANNOT_LIST_SUBSCRIPTIONS',
        message: `The ${args.provider} provider cannot list subscriptions, so there is nothing to import from.`,
        fix: 'Only providers that expose a list API can be imported from. For your own billing system, configure the external provider\'s subscriptions endpoint.',
      });
    }

    const run = await prisma.subscriptionImportRun.create({
      data: {
        applicationId: args.application.id,
        provider: args.provider,
        mode: 'dry_run',
        status: 'running',
        matchStrategy: args.matchStrategy,
        startedBy: args.startedBy,
      },
    });

    try {
      // Plan mapping is by slug first, then by any provider ref recorded on the
      // plan's metadata when it was registered. An operator therefore gets a
      // working mapping for free when their plan slugs already match.
      // Ordered, because the map below is built by insertion and an unordered
      // read makes which plan wins a collision depend on DB row order — which
      // can differ between the dry run and the apply, so the operator would
      // approve one mapping and get another.
      const plans = await prisma.plan.findMany({
        where: { applicationId: args.application.id },
        orderBy: { slug: 'asc' },
        select: { slug: true, metadata: true },
      });

      // Slugs first, in their own pass. A plan's OWN slug is the strongest
      // mapping there is and must never be overwritten by another plan's
      // recorded provider ref.
      const planByRef = new Map<string, string>();
      for (const p of plans) planByRef.set(p.slug, p.slug);

      // Then provider refs, and ONLY from the reserved provider blocks.
      //
      // `Plan.metadata` is free-form operator input — `stripProviderMetadata`
      // reserves exactly these three keys and lets every other key through
      // verbatim. So walking every nested object looking for a `planId` would
      // let an operator's own bookkeeping (`metadata.crm = { planId: 'x' }`)
      // silently map provider rows onto the wrong plan, and an import that
      // puts customers on the wrong plan is worse than one that reports it
      // cannot map them.
      //
      // Rekey itself only ever writes `metadata.stripe.priceId` (in
      // `registerAndSettle`, from what `ensurePlanRegistered` returns).
      // `planId` and `productId` are read by the PayPal and Razorpay modules
      // and are accepted here for a provider ref an operator recorded by hand.
      for (const p of plans) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        for (const providerKey of PROVIDER_METADATA_KEYS) {
          const block = meta[providerKey];
          if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
          for (const key of ['priceId', 'planId', 'productId']) {
            const v = (block as Record<string, unknown>)[key];
            // `has` guard: a ref must not displace a real slug, and the first
            // plan to claim a ref keeps it rather than the last one read.
            if (typeof v === 'string' && v !== '' && !planByRef.has(v)) {
              planByRef.set(v, p.slug);
            }
          }
        }
      }

      const planned: PlannedItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 500; page++) {
        const res = await impl.listSubscriptions({ limit: PAGE_SIZE, ...(cursor !== undefined && { cursor }) });
        for (const raw of res.items) {
          planned.push(await planRow(args.application, raw, args.matchStrategy, planByRef));
          if (planned.length >= MAX_ROWS) break;
        }
        if (planned.length >= MAX_ROWS || res.nextCursor === undefined) break;
        cursor = res.nextCursor;
      }

      // De-duplicate on externalId: a provider paginating an unstable sort can
      // return the same subscription twice, and importing it twice is exactly
      // what `externalId` exists to prevent.
      const seen = new Set<string>();
      const unique = planned.filter((p) =>
        seen.has(p.externalId) ? false : (seen.add(p.externalId), true),
      );

      await prisma.subscriptionImportItem.createMany({
        data: unique.map((p) => ({
          runId: run.id,
          externalId: p.externalId,
          email: p.email,
          planRef: p.planRef,
          outcome: p.outcome,
          endUserId: p.endUserId,
          planSlug: p.planSlug,
          // The provider's terms ride along in `detail` because that is the
          // only JSON column on the item, and apply has to honour them. They
          // are namespaced so the panel's `reason`/`hint` rendering is
          // unaffected.
          detail: {
            ...p.detail,
            ...(Object.keys(p.terms).length > 0 && { terms: p.terms }),
          } as Prisma.InputJsonValue,
        })),
      });
      await prisma.subscriptionImportRun.update({
        where: { id: run.id },
        data: {
          status: 'ready',
          counts: { ...tally(unique), total: unique.length },
          completedAt: new Date(),
        },
      });
      return { runId: run.id };
    } catch (err) {
      await prisma.subscriptionImportRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          error: (err as Error).message.slice(0, 500),
          completedAt: new Date(),
        },
      });
      throw err;
    }
  },

  /**
   * Apply a run that has been previewed.
   *
   * Only `match` and `create` items are acted on — the preview already decided,
   * and re-deciding here would mean applying something the operator never saw.
   * Each one goes through `grantSubscription`, so entitlements are materialised
   * and `subscription.activated` is announced exactly as for a real sale.
   */
  async apply(args: {
    application: Application;
    runId: string;
    actorId: string;
  }): Promise<{ imported: number; failed: number }> {
    const run = await prisma.subscriptionImportRun.findFirst({
      where: { id: args.runId, applicationId: args.application.id },
    });
    if (!run) {
      throw new RekeyError({
        statusCode: 404,
        code: 'IMPORT_RUN_NOT_FOUND',
        message: `Import run "${args.runId}" not found for this Application.`,
        fix: 'List recent runs to find one.',
      });
    }
    if (run.status !== 'ready') {
      throw new RekeyError({
        statusCode: 409,
        code: 'IMPORT_RUN_NOT_READY',
        message: `That run is "${run.status}", not "ready".`,
        fix:
          run.status === 'applied'
            ? 'It has already been applied. Start a new dry run to import anything new.'
            : 'Wait for the dry run to finish, or start a new one.',
      });
    }

    // Claim the run with a CONDITIONAL write. The status check above is a
    // read, and between it and this line a second operator pressing Apply on
    // the same preview would pass the same check — importing every row twice,
    // announcing `subscription.activated` twice, and running whatever
    // provisions downstream twice. Only the writer that moves the row out of
    // `ready` proceeds.
    const claimed = await prisma.subscriptionImportRun.updateMany({
      where: { id: run.id, status: 'ready' },
      data: { status: 'applying' },
    });
    if (claimed.count !== 1) {
      throw new RekeyError({
        statusCode: 409,
        code: 'IMPORT_RUN_NOT_READY',
        message: 'That run was already being applied.',
        fix: 'Someone else applied this preview a moment ago. Reload the run to see what landed.',
      });
    }

    // Everything from here to the terminal write is guarded, because the run
    // is now claimed as `applying` — a status nothing anywhere clears. An
    // exception escaping (the item read, or the error-marking update in the
    // per-row catch failing in turn) would leave the run stuck in it forever,
    // un-retryable, with no record of why.
    let items: Awaited<ReturnType<typeof prisma.subscriptionImportItem.findMany>>;
    try {
      items = await prisma.subscriptionImportItem.findMany({
        where: { runId: run.id, outcome: { in: ['match', 'create'] } },
      });
    } catch (err) {
      await markRunFailed(run.id, err);
      throw err;
    }

    const now = new Date();
    const seatWarnings: string[] = [];
    let quotaRefusal: RekeyError | null = null;
    let imported = 0;
    let failed = 0;
    try {
    for (const item of items) {
      try {
        let endUserId = item.endUserId;
        if (endUserId === null) {
          // Unlinked: no password, unverified, and marked so the end-user page
          // can explain why the account looks half-finished. They get in
          // through the normal recovery paths.
          // The workspace ceiling, exactly as sign-up, the billing webhook and
          // the operator create route apply it. Without this an import was the
          // one path in the API that could create end-users past a plan's
          // limit — and it is the path most likely to create thousands at once.
          //
          // Cached once it refuses: the ceiling only gets further out of reach
          // as a run proceeds, so a 5,000-row import against an exhausted
          // workspace should not issue 5,000 identical count queries to learn
          // the same thing. Each row is still marked `error` individually,
          // which is what makes the refusal legible in the preview.
          if (quotaRefusal !== null) throw quotaRefusal;
          try {
            await assertEndUserQuota(args.application.tenantId);
          } catch (e) {
            if (e instanceof RekeyError) quotaRefusal = e;
            throw e;
          }
          const role = await applicationRolesService.getDefault(args.application.id);
          let created: {
            id: string;
            email: string;
            emailVerified: boolean;
            role: string;
            createdAt: Date;
          } | null;
          try {
            created = await prisma.endUser.create({
              data: {
                applicationId: args.application.id,
                email: item.email!,
                passwordHash: null,
                emailVerified: false,
                role: role.name,
                metadata: { importedFrom: run.provider, importRunId: run.id },
              },
              select: { id: true, email: true, emailVerified: true, role: true, createdAt: true },
            });
          } catch (e) {
            // Two rows in the SAME run can carry one address — a customer with
            // two provider subscriptions is ordinary — and the preview
            // resolved both against an end-user that did not exist yet, so
            // both are `create`. Sign-up racing the run does it too. The
            // loser reads the winner back rather than failing a row that has
            // a perfectly good subscriber, which is the same resolution
            // `subscriber.service.ts` reached for billing webhooks.
            if ((e as { code?: string }).code !== 'P2002') throw e;
            const won = await prisma.endUser.findUniqueOrThrow({
              where: {
                applicationId_email: { applicationId: args.application.id, email: item.email! },
              },
              select: { id: true, erasedAt: true },
            });
            if (won.erasedAt !== null) {
              throw new RekeyError({
                statusCode: 409,
                code: 'END_USER_ERASED',
                message: 'That address belongs to an erased end-user and cannot be granted to.',
                fix: 'An erasure cannot be undone. The customer must be re-created under a new address.',
              });
            }
            created = null;
            endUserId = won.id;
          }
          if (created !== null) {
          endUserId = created.id;
          void recordSecurityEvent({
            type: 'end_user.created_by_import',
            actorType: 'operator',
            actorId: args.actorId,
            applicationId: args.application.id,
            metadata: { endUserId, provider: run.provider, importRunId: run.id },
          });
          emitDetached({
            applicationId: args.application.id,
            type: 'user.created',
            data: {
              user: {
                id: created.id,
                email: created.email,
                emailVerified: created.emailVerified,
                role: created.role,
                createdAt: created.createdAt.toISOString(),
                metadata: null,
              },
              via: `import:${run.provider}`,
            },
          });
          }
        }

        // The terms the provider reported, recorded at preview time.
        //
        // These have to be threaded or DELETED, not merely typed: without
        // them every imported subscription comes out open-ended, and
        // `docs/external-billing-pull.md` tells integrators the opposite —
        // that sending `currentPeriodEnd` is how the term is honoured. An
        // open-ended subscription also changes what CANCELLING it does later:
        // with no period, `cancelEffect` has nothing to schedule against and
        // access stops on the spot instead of at period end.
        const terms = ((item.detail ?? {}) as { terms?: Record<string, unknown> }).terms ?? {};
        const periodEnd = futureDate(terms.currentPeriodEnd, now);
        const cancelAt = futureDate(terms.cancelAt, now);

        const subscriberId = endUserId;
        if (subscriberId === null) throw new Error('No subscriber could be resolved for this row.');

        const result = await subscriptionGrantsService.grantSubscription({
          application: args.application,
          planSlug: item.planSlug!,
          endUserId: subscriberId,
          note: `Imported from ${run.provider} (${item.externalId})`,
          providerBinding: { provider: run.provider, providerSubId: item.externalId },
          ...(periodEnd !== undefined && { currentPeriodEnd: periodEnd }),
        });

        // Only ever decorate a row THIS call created. `activated: false` means
        // the subscriber was already entitled on this plan and nothing was
        // written — rewriting that row's terms from a file would be the
        // overwrite this feature exists not to do.
        if (result.activated) {
          const provenance = {
            importedFrom: run.provider,
            importRunId: run.id,
            externalId: item.externalId,
            ...(typeof terms.customerExternalId === 'string' && {
              customerExternalId: terms.customerExternalId,
            }),
            // Recorded rather than dropped. Deliberately NOT written onto the
            // end-user: an import must not rename somebody who already has an
            // account here.
            ...(typeof terms.customerName === 'string' && {
              customerName: terms.customerName,
            }),
            ...(typeof terms.startedAt === 'string' && { providerStartedAt: terms.startedAt }),
            ...(terms.metadata !== undefined && { providerMetadata: terms.metadata }),
          };
          const merged = {
            ...((result.subscription.metadata ?? {}) as Record<string, unknown>),
            import: provenance,
          };
          // The same 16 KB ceiling every other metadata write observes. A
          // provider that returns a large blob per row loses the blob, not
          // the subscription.
          let metadata: Record<string, unknown> = merged;
          try {
            assertMetadataWithinLimit(merged);
          } catch {
            const trimmed = {
              ...((result.subscription.metadata ?? {}) as Record<string, unknown>),
              import: { ...provenance, providerMetadata: '[dropped: over the metadata limit]' },
            };
            // Re-checked, because the fields that survive the trim are
            // unbounded provider strings too — so "the same ceiling every
            // other metadata write observes" has to be enforced twice, not
            // asserted once.
            try {
              assertMetadataWithinLimit(trimmed);
              metadata = trimmed;
            } catch {
              metadata = {
                ...((result.subscription.metadata ?? {}) as Record<string, unknown>),
                import: {
                  importedFrom: run.provider,
                  importRunId: run.id,
                  externalId: item.externalId,
                  note: '[provider fields dropped: over the metadata limit]',
                },
              };
            }
          }
          await prisma.subscription.update({
            where: { id: result.subscription.id },
            data: {
              metadata: metadata as Prisma.InputJsonValue,
              ...(cancelAt !== undefined && { cancelAt }),
            },
          });

          // Seats.
          //
          // The override key has to be the plan's ACTUAL licence key, not a
          // guess. `'LICENSE:'` with an empty key half only ever matches a
          // legacy plan that `synthesizeLegacy` resolves — one with
          // `kind: 'LICENSE'` and no explicit entitlement rows. A plan
          // carrying the ordinary modern shape (`LICENSE:seats`) would have
          // been refused by `mergePatch` every single time, so the seat count
          // was reported as applied in the doc and silently downgraded to a
          // line of run `error` text in practice.
          const quantity = terms.quantity;
          if (typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 1) {
            const planRows = await entitlementsService
              .resolveForPlan(await prisma.plan.findUniqueOrThrow({ where: { id: result.subscription.planId } }))
              .catch(() => []);
            const licence = planRows.find((r) => r.kind === 'LICENSE');
            if (licence === undefined) {
              // Not an error. The provider sold a seat count for something
              // this plan does not license, and inventing a LICENSE
              // entitlement the plan never carried would be selling something
              // nobody agreed to.
              seatWarnings.push(
                `${item.externalId}: plan "${item.planSlug}" has no LICENSE entitlement, so quantity ${quantity} was not applied`,
              );
            } else {
              try {
                const patched = await entitlementOverridesService.patch({
                  applicationId: args.application.id,
                  subscriptionId: result.subscription.id,
                  patch: { [`LICENSE:${licence.key}`]: quantity },
                });
                // After the transaction committed, never inside it — the same
                // reason the tenant override route kicks here. Without this the
                // `entitlements_updated` rows sit waiting for the retry poller.
                kickDeliveries(patched.deliveryIds);
              } catch (e) {
                seatWarnings.push(
                  `${item.externalId}: seats not applied (${(e as Error).message.slice(0, 120)})`,
                );
              }
            }
          }
        }

        await prisma.subscriptionImportItem.update({
          where: { id: item.id },
          data: { endUserId: subscriberId, subscriptionId: result.subscription.id },
        });
        imported += 1;
      } catch (err) {
        failed += 1;
        // One bad row must not abandon the rest: an import that stops halfway
        // leaves the operator with no way to tell what landed.
        await prisma.subscriptionImportItem.update({
          where: { id: item.id },
          data: {
            outcome: 'error',
            detail: { reason: (err as Error).message.slice(0, 500) } as Prisma.InputJsonValue,
          },
        });
      }
    }

    } catch (err) {
      await markRunFailed(run.id, err);
      throw err;
    }

    const counts = (run.counts ?? {}) as Record<string, number>;
    await prisma.subscriptionImportRun.update({
      where: { id: run.id },
      data: {
        mode: 'applied',
        status: 'applied',
        counts: { ...counts, imported, failed } as Prisma.InputJsonValue,
        // A subscription that landed but whose seat count did not is a
        // half-delivered deal, and the operator has to be told which ones.
        ...(seatWarnings.length > 0 && { error: seatWarnings.join('; ').slice(0, 500) }),
        completedAt: new Date(),
      },
    });

    void recordSecurityEvent({
      type: 'app.subscriptions_imported',
      actorType: 'operator',
      actorId: args.actorId,
      applicationId: args.application.id,
      metadata: { importRunId: run.id, provider: run.provider, imported, failed },
    });
    return { imported, failed };
  },
};
