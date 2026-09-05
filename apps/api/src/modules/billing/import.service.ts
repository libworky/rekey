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
import { emitDetached } from '../webhooks/webhook.service.js';

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
  const base = { externalId, email, planRef, endUserId: null, planSlug: null };

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
      const plans = await prisma.plan.findMany({
        where: { applicationId: args.application.id },
        select: { slug: true, metadata: true },
      });
      const planByRef = new Map<string, string>();
      for (const p of plans) {
        planByRef.set(p.slug, p.slug);
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        for (const key of ['providerPlanId', 'providerPriceId', 'externalPlanRef']) {
          const v = meta[key];
          if (typeof v === 'string' && v !== '') planByRef.set(v, p.slug);
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
          detail: p.detail as Prisma.InputJsonValue,
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

    await prisma.subscriptionImportRun.update({
      where: { id: run.id },
      data: { status: 'applying' },
    });

    const items = await prisma.subscriptionImportItem.findMany({
      where: { runId: run.id, outcome: { in: ['match', 'create'] } },
    });

    let imported = 0;
    let failed = 0;
    for (const item of items) {
      try {
        let endUserId = item.endUserId;
        if (endUserId === null) {
          // Unlinked: no password, unverified, and marked so the end-user page
          // can explain why the account looks half-finished. They get in
          // through the normal recovery paths.
          const role = await applicationRolesService.getDefault(args.application.id);
          const created = await prisma.endUser.create({
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

        const result = await subscriptionGrantsService.grantSubscription({
          application: args.application,
          planSlug: item.planSlug!,
          endUserId,
          note: `Imported from ${run.provider} (${item.externalId})`,
          providerBinding: { provider: run.provider, providerSubId: item.externalId },
        });
        await prisma.subscriptionImportItem.update({
          where: { id: item.id },
          data: { endUserId, subscriptionId: result.subscription.id },
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

    const counts = (run.counts ?? {}) as Record<string, number>;
    await prisma.subscriptionImportRun.update({
      where: { id: run.id },
      data: {
        mode: 'applied',
        status: 'applied',
        counts: { ...counts, imported, failed } as Prisma.InputJsonValue,
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
