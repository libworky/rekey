/**
 * Security audit log writer.
 *
 * Appends security-relevant events (sign-ins, session kill-switch, API-key
 * lifecycle, …) to the `security_events` table for incident forensics.
 *
 * **Best-effort, never fatal.** A logging failure must not break the operation
 * being recorded, so `recordSecurityEvent` swallows its own errors. Call it
 * fire-and-forget: `void recordSecurityEvent({...})`.
 */

import type { FastifyRequest } from 'fastify';
import type { SecurityEventType } from '@rekey.dev/shared-types';
import { prisma } from './prisma.js';

export type SecurityActorType = 'operator' | 'end_user' | 'system';

/**
 * Event types this API emits that `@rekey.dev/shared-types` does not label yet.
 *
 * The rule stays what it was — an emit site names a type from the shared union,
 * so the panel can label it — and this is the documented exception, not a way
 * around it. Both entries are the operator counterparts of `user.sign_in_failed`
 * / `user.locked_out`, added when operator sign-in failures were found to be
 * recorded nowhere at all. `humanizeSecurityEventType` degrades an unlabelled
 * key gracefully ("Sign in failed", "Locked out") rather than printing it raw,
 * so the panel is readable in the meantime.
 *
 * **Delete these two entries the moment shared-types carries them.** Nothing
 * breaks if you forget — the union just stops narrowing usefully.
 */
export type PendingSecurityEventType = 'operator.sign_in_failed' | 'operator.locked_out';

/** Every type an emit site in this API may name. */
export type EmittableSecurityEventType = SecurityEventType | PendingSecurityEventType;

export interface SecurityEventInput {
  /**
   * Dotted event name, e.g. "operator.sign_in", "app.sessions_rotated".
   *
   * Typed against the union in `@rekey.dev/shared-types`, which is also what
   * the operator panel labels events from. It used to be a bare `string`, and
   * a bare `string` on both sides is how the panel ended up rendering 44 of
   * the 54 types as raw keys: nothing connected an emit site to the list of
   * things anyone could display. Adding an event now means adding it there,
   * with a label, or this does not compile — the sole exception being
   * `PendingSecurityEventType`, which is enumerated above and is not a hole a
   * new event can slip through unnoticed.
   */
  type: EmittableSecurityEventType;
  actorType: SecurityActorType;
  actorId?: string | null;
  tenantId?: string | null;
  applicationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/** Pull the inbound IP + (truncated) user-agent off a request for the log. */
export function requestContext(req: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip || null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}

/**
 * `applicationId` → `tenantId`. An Application never changes workspace, so this
 * is immutable for the life of the row and safe to memoise for the life of the
 * process. It exists so the backfill below costs one query per Application
 * rather than one per event: `recordSecurityEvent` is on the sign-in path.
 */
const tenantOfApplication = new Map<string, string>();

/**
 * Resolve the workspace an event belongs to when the caller named only the
 * Application.
 *
 * ## Why this is not the caller's job
 *
 * `securityEventWhere` scopes EVERY tenant-facing read by `tenantId`, so a row
 * written without one is durable, correct, and invisible: it is in the table
 * and it is in no operator's log. Six emit sites had this shape — the five
 * device events (`user.device_registered`, `user.device_limit_reached`,
 * `user.device_released` / `end_user.device_released`, `end_user.device_blocked`,
 * `end_user.device_unblocked`) and `user.session_handoff_granted` — against 53
 * that pass `tenantId` correctly. The entire device audit trail was therefore
 * unreachable from the panel: blocking someone's device recorded an event that
 * appeared neither in the workspace Activity log nor on the end-user it
 * happened to.
 *
 * Requiring every caller to remember is what produced the bug, and the six that
 * forgot are the six furthest from a request context (a service that takes an
 * `applicationId`, not a `req`). Deriving it here fixes those six and the
 * seventh nobody has written yet. Callers that pass `tenantId` are untouched.
 *
 * Best-effort like everything else in this file: if the lookup fails the event
 * is still written, exactly as before.
 */
async function resolveTenantId(applicationId: string): Promise<string | null> {
  const cached = tenantOfApplication.get(applicationId);
  if (cached !== undefined) return cached;
  const app = await prisma.application
    .findUnique({ where: { id: applicationId }, select: { tenantId: true } })
    .catch(() => null);
  const tenantId = app?.tenantId ?? null;
  // Only memoise a hit. A miss can mean "not created yet" in a racing test,
  // and caching null would make that permanent for the process.
  if (tenantId !== null) tenantOfApplication.set(applicationId, tenantId);
  return tenantId;
}

/**
 * Drop the application→tenant memo between tests.
 *
 * Registered in `test/domain-tables.ts` alongside the other module-level
 * singletons the per-test TRUNCATE cannot reach. A cuid is never reissued, so a
 * stale entry cannot actually mislead a later test — this is here because
 * "module state that outlives a truncate" is a category this suite tracks
 * deliberately, and an unregistered one is the next person's debugging session.
 */
export function __resetForTests(): void {
  tenantOfApplication.clear();
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    const tenantId =
      input.tenantId ??
      (input.applicationId ? await resolveTenantId(input.applicationId) : null);
    await prisma.securityEvent.create({
      data: {
        type: input.type,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        tenantId,
        applicationId: input.applicationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? {}) as object,
      },
    });
  } catch {
    // Best-effort: an audit-log write must never break the action it records.
  }
}

export interface SecurityEventQuery {
  tenantId: string;
  applicationId?: string | undefined;
  type?: string | undefined;
  actorType?: SecurityActorType | undefined;
  /** Inclusive createdAt window. */
  from?: Date | undefined;
  to?: Date | undefined;
  /** Sort column (allowlisted at the route). Default createdAt. */
  sort?: 'createdAt' | 'type' | undefined;
  /** Sort direction. Default desc (newest first). */
  order?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /**
   * Hard cap on `limit`. Defaults to 200 (panel pages). The CSV export
   * passes a larger cap (it streams a bounded file, not a rendered table).
   */
  cap?: number | undefined;
}

/**
 * The filter `listSecurityEvents` and `countSecurityEvents` share.
 *
 * One builder for both: a `total` computed over a different filter than the
 * rows is a pager that walks off the end of the log.
 */
function securityEventWhere(query: SecurityEventQuery) {
  return {
    tenantId: query.tenantId,
    ...(query.applicationId !== undefined && { applicationId: query.applicationId }),
    ...(query.type !== undefined && { type: query.type }),
    ...(query.actorType !== undefined && { actorType: query.actorType }),
    ...((query.from || query.to) && {
      createdAt: {
        ...(query.from && { gte: query.from }),
        ...(query.to && { lte: query.to }),
      },
    }),
  };
}

/** Total events matching the same filters `listSecurityEvents` applies. */
export async function countSecurityEvents(query: SecurityEventQuery): Promise<number> {
  return prisma.securityEvent.count({ where: securityEventWhere(query) });
}

/** List recent security events for a tenant (newest first, capped at `cap` — default 200). */
export async function listSecurityEvents(query: SecurityEventQuery): Promise<
  Array<{
    id: string;
    type: string;
    actorType: string;
    actorId: string | null;
    applicationId: string | null;
    ip: string | null;
    userAgent: string | null;
    metadata: unknown;
    createdAt: Date;
  }>
> {
  const rows = await prisma.securityEvent.findMany({
    where: securityEventWhere(query),
    // Stable secondary order by id keeps pagination consistent on ties.
    orderBy: [
      query.sort === 'type'
        ? { type: query.order ?? 'desc' }
        : { createdAt: query.order ?? 'desc' },
      { id: 'desc' },
    ],
    take: Math.min(query.limit ?? 50, query.cap ?? 200),
    skip: query.offset ?? 0,
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorType: r.actorType,
    actorId: r.actorId,
    applicationId: r.applicationId,
    ip: r.ip,
    userAgent: r.userAgent,
    metadata: r.metadata,
    createdAt: r.createdAt,
  }));
}
