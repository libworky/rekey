/**
 * The one place an operator's application access is decided.
 *
 * ## Why this file exists
 *
 * Until now the decision lived in three copies: `ensureAppAccess` and
 * `appAccessScope` in `app-access.ts` for REST, and `accessibleApplicationIds`
 * in `tenant-mcp/operator-tools.ts` for MCP — with `loadAppInTenant` in
 * `operator-write-tools.ts` wrapping the third. The copy existed for a stated
 * reason: the REST helper took a `FastifyRequest`, and MCP handlers have no
 * request. Its own docstring said "if the two ever diverge, this is the copy
 * to fix", and they had: the MCP copy modelled `read` and only `read`, and its
 * caller warned in a comment that it would not protect a member write tool.
 *
 * The fix is not a fourth copy. It is one decision function that takes a plain
 * context — `{ tenantId, role, membershipId }` — and two thin adapters that
 * build that context from a request or from a tool context. The grants query,
 * the legacy-member rule, the OWNER/ADMIN short-circuit and the
 * denied-is-indistinguishable-from-absent 404 now have exactly one home.
 *
 * ## What this refactor deliberately does NOT change
 *
 * Every observable behaviour is preserved byte for byte, including two places
 * where the old copies genuinely differed and a naive merge would have picked
 * one:
 *
 *   - `ensureAppAccess` with no membership id falls back to resolving one from
 *     `(tenantUser, tenantId)` and throws 500 if that fails; the MCP path
 *     returns `[]` (fails closed). Both survive: the fallback lives in the
 *     request adapter, and `accessibleApplicationIds` still returns `[]`.
 *   - `accessibleApplicationIds` lists every Application in the workspace for
 *     OWNER/ADMIN and filters for members; `applicationAccess` looks up one
 *     row. Different shapes for different questions, both kept.
 *
 * The three behaviours that have to agree — and the comment in the old code
 * saying "all three have to agree" — are now one code path, so the sentence
 * can be retired along with the risk it described.
 *
 * `AppAccessNeed` is the vocabulary today: `read | write | billing-write`.
 * Scopes on the membership (the operator-permissions spec) attach here, in the
 * context and the decision, and nowhere else.
 */

import type { FastifyRequest } from 'fastify';
import type { ApplicationGrantRole, TenantRole } from '@prisma/client';
import { prisma } from './prisma.js';
import { RekeyError } from './error.js';

export type AppAccessNeed = 'read' | 'write' | 'billing-write';

export interface AppAccess {
  /**
   * How the access was satisfied:
   *  - 'workspace-admin' — caller is OWNER/ADMIN (implicit full access)
   *  - 'legacy-member'   — grandfathered pre-grants membership (read-only)
   *  - ApplicationGrantRole   — MEMBER via an explicit grant on this Application
   */
  level: 'workspace-admin' | 'legacy-member' | ApplicationGrantRole;
}

export interface AppAccessScope {
  /** false → caller sees every Application in the workspace (OWNER/ADMIN or grandfathered member). */
  restricted: boolean;
  /** Granted application ids (only meaningful when restricted). */
  applicationIds: string[];
  /** applicationId → granted role (only meaningful when restricted). */
  roleByApplicationId: Map<string, ApplicationGrantRole>;
}

/**
 * Everything the decision needs, and nothing tied to a transport.
 *
 * `membershipId` is null when the auth path could not resolve one. Every grant
 * check then fails CLOSED — a member whose grants cannot be read must not be
 * handed the workspace — except `applicationAccess`, which treats it as a
 * programming error (see `accessContextFromRequest`).
 */
export interface AccessContext {
  tenantId: string;
  role: TenantRole;
  membershipId: string | null;
}

function internal(message: string, fix: string): RekeyError {
  return new RekeyError({ statusCode: 500, code: 'INTERNAL_ERROR', message, fix });
}

/**
 * Build the context from an operator request. Must run after one of the
 * operator auth middlewares (`requireTenantSession`, `resolveOperatorToken`,
 * the MCP bearer resolver) — all three set `tenantId`, `tenantRole` and
 * `tenantMembershipId`.
 *
 * Async only for the defensive fallback `ensureAppAccess` always had: an auth
 * path that set `tenantUser`/`tenantId` but not the membership id gets one
 * resolved here. No current path needs it; it is preserved, not relied on.
 */
export async function accessContextFromRequest(req: FastifyRequest): Promise<AccessContext> {
  if (!req.tenantId || !req.tenantRole) {
    throw internal(
      'ensureAppAccess used without requireTenantSession.',
      'Register requireTenantSession before the route handler.',
    );
  }
  let membershipId: string | null = req.tenantMembershipId ?? null;
  if (membershipId === null && req.tenantUser) {
    const membership = await prisma.tenantMembership.findUnique({
      where: {
        tenantUserId_tenantId: { tenantUserId: req.tenantUser.id, tenantId: req.tenantId },
      },
      select: { id: true },
    });
    membershipId = membership?.id ?? null;
  }
  return { tenantId: req.tenantId, role: req.tenantRole, membershipId };
}

/** Build the context from an MCP tool context. Synchronous; nothing to resolve. */
export function accessContextFromTool(ctx: {
  tenantId: string;
  role: TenantRole;
  tenantMembershipId?: string | undefined;
}): AccessContext {
  return { tenantId: ctx.tenantId, role: ctx.role, membershipId: ctx.tenantMembershipId ?? null };
}

export interface GrantSet {
  /** applicationId → granted role. */
  byApplication: Map<string, ApplicationGrantRole>;
  /**
   * Grandfathered pre-grants membership: workspace-wide READ, no writes.
   * Set ONLY by the 2.0.0-rc.3 backfill. Only meaningful when
   * `byApplication` is empty — setting a grant clears the flag, and the
   * migration cleared it for any row that already had one, so "grandfathered
   * AND granted" is unreachable. If it ever did occur, grants win, exactly as
   * they always have.
   */
  legacyWorkspaceRead: boolean;
}

/**
 * The one grants query. Every decision below reads through this.
 *
 * A context with no membership id resolves to an empty set with the legacy
 * flag off — the closed default — rather than throwing, so a caller that
 * wants to fail closed can, and a caller that wants to treat it as a
 * programming error checks before calling.
 */
export async function resolveGrantSet(ctx: AccessContext): Promise<GrantSet> {
  if (ctx.membershipId === null) {
    return { byApplication: new Map(), legacyWorkspaceRead: false };
  }
  const [grants, membership] = await Promise.all([
    prisma.applicationGrant.findMany({
      where: { tenantMembershipId: ctx.membershipId },
      select: { applicationId: true, role: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { id: ctx.membershipId },
      select: { legacyWorkspaceRead: true },
    }),
  ]);
  return {
    byApplication: new Map(grants.map((g) => [g.applicationId, g.role])),
    // `grants.length === 0` as well as the flag, deliberately — see GrantSet.
    legacyWorkspaceRead: grants.length === 0 && membership?.legacyWorkspaceRead === true,
  };
}

function isWorkspaceAdmin(role: TenantRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function notFound(applicationId: string): RekeyError {
  // Don't disclose existence (in another tenant, or behind a missing grant) —
  // return the same code as "not found" to avoid being an enumeration oracle.
  return new RekeyError({
    statusCode: 404,
    code: 'APPLICATION_NOT_FOUND',
    message: `Application "${applicationId}" not found in this workspace.`,
    fix: 'List applications via GET /api/v1/tenant/applications.',
  });
}

function legacyWriteDenied(role: string): RekeyError {
  // Same code/shape requireTenantRole(['OWNER','ADMIN']) used to emit for a
  // MEMBER hitting these routes — kept for client back-compat.
  return new RekeyError({
    statusCode: 403,
    code: 'TENANT_ROLE_INSUFFICIENT',
    message: `This action requires one of: OWNER, ADMIN. Your role: ${role}.`,
    fix: 'Ask a workspace owner or admin to perform this action, to upgrade your role, or to grant you an application role (APP_ADMIN / APP_BILLING).',
  });
}

function grantDenied(need: AppAccessNeed, granted: ApplicationGrantRole): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'APP_ACCESS_DENIED',
    message: `Your application role ${granted} does not allow this action (requires ${
      need === 'billing-write' ? 'APP_BILLING or APP_ADMIN' : 'APP_ADMIN'
    }).`,
    fix: 'Ask a workspace owner or admin to raise your application grant via PUT /api/v1/tenant/workspace/members/:membershipId/grants.',
  });
}

/**
 * May this caller perform `need` on this Application? Answers BOTH questions
 * the old helper did: does the Application belong to the workspace (404
 * otherwise, same non-disclosure posture), and is the caller allowed `need`
 * on it.
 *
 *   OWNER / ADMIN   → implicit full access.
 *   MEMBER          → grants are authoritative, INCLUDING when there are none.
 *                     No grant → 404 (denied is indistinguishable from absent).
 *                     APP_VIEWER read · APP_BILLING read + billing-write ·
 *                     APP_ADMIN everything. Insufficient → 403 APP_ACCESS_DENIED.
 *   legacy member   → read only, writes 403 TENANT_ROLE_INSUFFICIENT.
 */
export async function applicationAccess(
  ctx: AccessContext,
  applicationId: string,
  need: AppAccessNeed,
): Promise<AppAccess> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { tenantId: true },
  });
  if (!app || app.tenantId !== ctx.tenantId) throw notFound(applicationId);

  if (isWorkspaceAdmin(ctx.role)) return { level: 'workspace-admin' };

  if (ctx.membershipId === null) {
    throw internal(
      'ensureAppAccess used without requireTenantSession.',
      'Register requireTenantSession before the route handler.',
    );
  }
  const grants = await resolveGrantSet(ctx);
  const role = grants.byApplication.get(applicationId);
  if (role === undefined) {
    if (grants.legacyWorkspaceRead) {
      if (need === 'read') return { level: 'legacy-member' };
      throw legacyWriteDenied(ctx.role);
    }
    // Default since 2.0.0-rc.3: closed. Same 404 an ungranted Application
    // already returned for a member who held grants elsewhere.
    throw notFound(applicationId);
  }

  if (need === 'read') return { level: role };
  if (need === 'billing-write') {
    if (role === 'APP_ADMIN' || role === 'APP_BILLING') return { level: role };
    throw grantDenied(need, role);
  }
  // need === 'write'
  if (role === 'APP_ADMIN') return { level: role };
  throw grantDenied(need, role);
}

/**
 * Which Applications may the caller see at all? Feeds the list endpoint, the
 * panel sidebar and the command palette.
 */
export async function accessScope(ctx: AccessContext): Promise<AppAccessScope> {
  if (isWorkspaceAdmin(ctx.role) || ctx.membershipId === null) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  const grants = await resolveGrantSet(ctx);
  // Grandfathered pre-grants membership — workspace-wide read. Zero grants on
  // its own no longer widens the scope: since 2.0.0-rc.3 it narrows it to
  // nothing, which is what a new MEMBER invitation is supposed to produce.
  if (grants.legacyWorkspaceRead) {
    return { restricted: false, applicationIds: [], roleByApplicationId: new Map() };
  }
  return {
    restricted: true,
    applicationIds: [...grants.byApplication.keys()],
    roleByApplicationId: grants.byApplication,
  };
}

/**
 * The Applications this caller may READ, as ids — what the MCP handlers
 * resolve their Application set through.
 *
 * Returns `[]` for a caller with grants that name no Application, which every
 * handler treats as "nothing to show" — the same empty result an operator with
 * no Applications gets, so a denied Application is indistinguishable from an
 * absent one. A context with no membership id also returns `[]`: fail CLOSED.
 */
export async function accessibleApplicationIds(ctx: AccessContext): Promise<string[]> {
  const all = await prisma.application.findMany({
    where: { tenantId: ctx.tenantId },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const allIds = all.map((a) => a.id);
  if (isWorkspaceAdmin(ctx.role)) return allIds;
  if (ctx.membershipId === null) return [];
  const grants = await resolveGrantSet(ctx);
  if (grants.legacyWorkspaceRead) return allIds;
  return allIds.filter((id) => grants.byApplication.has(id));
}
