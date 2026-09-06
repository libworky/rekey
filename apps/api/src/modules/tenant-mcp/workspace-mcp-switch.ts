/**
 * The per-workspace switch for the operator MCP server.
 *
 * Two kill switches exist above and below this one. OPERATOR_MCP_ENABLED is
 * deployment-wide: off, and the server does not mount for anybody.
 * `authConfig.mcpEnabled` is per APPLICATION and governs the end-user MCP
 * server, a different thing. Neither lets one workspace's owner say "no agent
 * acts as any of my operators", which is the decision this column makes.
 *
 * Checked at AUTH time on both bearer paths and at CONSENT, so switching it
 * off refuses every token already issued for the workspace on its next
 * request and mints no new ones. Nothing is revoked — turn it back on and the
 * same credentials work again. Refusing rather than revoking is deliberate:
 * an owner who flips this off for an incident should not have to re-onboard
 * every agent afterwards.
 */

import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

export function operatorMcpDisabled(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_MCP_DISABLED',
    message: 'The operator MCP server is switched off for this workspace.',
    fix: 'A workspace owner or admin can turn it back on under Workspace settings (PATCH /api/v1/tenant/workspace { operatorMcpEnabled: true }).',
  });
}

/** Throw unless the workspace admits operator MCP. One indexed read. */
export async function assertOperatorMcpEnabled(tenantId: string): Promise<void> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { operatorMcpEnabled: true },
  });
  if (t === null || t.operatorMcpEnabled === false) throw operatorMcpDisabled();
}
