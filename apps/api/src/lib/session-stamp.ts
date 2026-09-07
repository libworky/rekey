/**
 * The session kill switch.
 *
 * `EndUser.sessionsInvalidBefore` and `TenantUser.sessionsInvalidBefore` are
 * stamped by every path that ends a session early: password change or reset,
 * sign-out everywhere, a single-session revoke, a device release or block. An
 * access token whose `iat` falls before the stamp is refused on its next use,
 * whatever lifetime it was issued with. Compared at second granularity
 * because `iat` is seconds: a token minted in the same second as the stamp
 * survives, which is the pair the stamping request itself may hand back.
 */
export function sessionIssuedBefore(claims: { iat?: number }, stamp: Date | null | undefined): boolean {
  if (!stamp) return false;
  return typeof claims.iat === 'number' && claims.iat < Math.floor(stamp.getTime() / 1000);
}
