/**
 * End-user Security — can they get in, who has been in, and who has acted as
 * them.
 *
 * The activity table here is the one that changed most in the split. It used to
 * scan `actorType=end_user` only, which meant everything an OPERATOR did to
 * this person (block a device, unblock it, release one on their behalf, erase
 * them) and everything the SYSTEM did (create them from a billing event) was
 * recorded and then shown nowhere on their page. `getEndUserEvents` scans all
 * three actor types and merges on either `actorId` or `metadata.endUserId`.
 */

import * as React from 'react';
import { cookies } from 'next/headers';
import { humanizeEventType } from '@/lib/security-events';
import { formatDateTime } from '@/lib/date';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { CopyButton } from '@/components/CopyButton';
import { SubmitButton } from '@/components/SubmitButton';
import { impersonate } from '../actions';
import {
  getEndUserDetail,
  getEndUserEvents,
  AUTH_EVENT_SCAN,
  AUTH_EVENTS_SHOWN,
  IMPERSONATE_COOKIE,
  LOGIN_LOCK_MINUTES,
  LOGIN_LOCK_THRESHOLD,
} from '../shared';

const IMPERSONATE_ERR: Record<string, string> = {
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can impersonate end-users.',
};

/**
 * Readable one-liner from an event's `metadata`. The shape varies by type
 * (`{via}` on sign-in, `{reason}` where the API records one, `{deviceId}` and
 * `{sessionsRevoked}` on the device events), so pick the keys worth surfacing
 * and fall back to a compact render of whatever is there.
 */
function eventDetail(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parts: string[] = [];
  for (const key of [
    'via',
    'reason',
    'deviceName',
    'provider',
    'releasedBy',
    'sessionsRevoked',
    'count',
  ] as const) {
    const v = metadata[key];
    if (typeof v === 'string' && v !== '') parts.push(`${key}: ${v.replace(/_/g, ' ')}`);
    else if (typeof v === 'number') parts.push(`${key}: ${v}`);
  }
  if (parts.length > 0) return parts.join(' · ');
  const keys = Object.keys(metadata);
  return keys.length === 0 ? null : keys.slice(0, 3).join(', ');
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';

export default async function EndUserSecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const impError = typeof sp.impError === 'string' ? sp.impError : undefined;
  const impersonated = sp.impersonated === '1';

  const [detail, events] = await Promise.all([
    getEndUserDetail(id, euid),
    getEndUserEvents(id, euid),
  ]);

  type Reveal = { accessToken: string; accessTokenExpiresAt: string };
  let reveal: Reveal | null = null;
  if (impersonated) {
    const jar = await cookies();
    const raw = jar.get(IMPERSONATE_COOKIE)?.value;
    if (raw) {
      try {
        reveal = JSON.parse(raw) as Reveal;
      } catch {
        /* stale */
      }
    }
  }

  const lockedUntil = detail.endUser.lockedUntil ? new Date(detail.endUser.lockedUntil) : null;
  const lockedNow = lockedUntil !== null && lockedUntil > new Date();
  const shown = events?.slice(0, AUTH_EVENTS_SHOWN) ?? [];

  return (
    <div className="space-y-6">
      {impersonated && reveal && (
        <div
          aria-live="polite"
          className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950"
        >
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Impersonation token minted — shown once
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Expires {formatDateTime(reveal.accessTokenExpiresAt)}. Use as{' '}
            <code className="font-mono">X-Rekey-User-Token</code> against your customer app&apos;s
            Rekey-backed endpoints. Rekey records this in{' '}
            <code className="font-mono">impersonation_audits</code> with your operator id.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded border border-amber-200 bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-fg)] dark:border-amber-800">
              {reveal.accessToken}
            </code>
            <CopyButton value={reveal.accessToken} label="Copy" />
          </div>
        </div>
      )}
      {impError && <Banner tone="error">{IMPERSONATE_ERR[impError] ?? impError}</Banner>}

      <Card className="space-y-3">
        <SectionHeader
          title="Sign-in health"
          description="Lockout state from the API's brute-force limiter. It lives in Redis, not on the end-user row."
        />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt
              className="text-xs text-[var(--color-muted-fg)]"
              title={
                lockedNow
                  ? 'At least this many failures tripped the lockout. The counter is consumed when the lock is set, so this is the threshold, not a live count.'
                  : 'Failures in the current 15-minute window. Resets on a successful sign-in.'
              }
            >
              Failed sign-in attempts
            </dt>
            {/* A bare "7" told the operator nothing: 7 of what? The threshold
                is the whole point of the number, so show the denominator. */}
            <dd className="text-[var(--color-fg)]">
              {lockedNow ? '≥ ' : ''}
              {detail.endUser.failedSignInAttempts}
              <span className="text-[var(--color-muted-fg)]"> of {LOGIN_LOCK_THRESHOLD}</span>
              {!lockedNow && detail.endUser.failedSignInAttempts > 0 && (
                <span className="block text-xs text-[var(--color-muted-fg)]">
                  {LOGIN_LOCK_THRESHOLD - detail.endUser.failedSignInAttempts} more locks the account
                  for {LOGIN_LOCK_MINUTES} minutes
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Lockout</dt>
            <dd>
              {lockedNow ? (
                <Badge tone="danger" dot>
                  locked until {formatDateTime(lockedUntil)}
                </Badge>
              ) : (
                <span className="text-[var(--color-muted-fg)]">none</span>
              )}
            </dd>
          </div>
        </dl>
        {lockedNow && (
          <p className="text-[11px] text-[var(--color-muted-fg)]">
            The lock expires on its own. There is no operator unlock endpoint yet, so the only ways
            out today are waiting it out or a successful sign-in once it lapses.
          </p>
        )}
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title="Activity"
          count={`(${shown.length})`}
          description={`Last ${AUTH_EVENTS_SHOWN} recorded events for this end-user, newest first — theirs, an operator's on them, and the system's.`}
        />

        <Banner tone="info">
          Successful sign-ins, credential changes and operator actions only.{' '}
          <strong>Failed</strong> sign-ins and lockouts are counted in Redis and never written as
          events, so they cannot appear here — the counter above is the only signal, and it resets on
          a successful sign-in.
        </Banner>

        {events === null ? (
          <EmptyState
            variant="inline"
            title="Activity is not visible to your role"
            description="Listing security events requires the OWNER or ADMIN workspace role."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No recorded events"
            description={`Nothing for this user in the application's most recent ${AUTH_EVENT_SCAN} events per actor type. On a busy application that window may not reach back far.`}
          />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Actor</TH>
                <TH>Detail</TH>
                <TH>IP</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((e) => (
                <TR key={e.id} hover>
                  <TD>
                    <div className="font-medium text-[var(--color-fg)]">
                      {humanizeEventType(e.type)}
                    </div>
                    <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                  </TD>
                  <TD muted className="text-xs">
                    {e.actorType === 'end_user'
                      ? 'this user'
                      : e.actorType === 'operator'
                        ? 'operator'
                        : 'system'}
                  </TD>
                  <TD className="text-xs text-[var(--color-muted-fg)]">
                    {eventDetail(e.metadata) ?? '—'}
                  </TD>
                  <TD mono muted className="text-xs">
                    <span title={e.userAgent ?? undefined}>{e.ip ?? '—'}</span>
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(e.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <Card className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Impersonate this user</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            OWNER / ADMIN only. Mints a 5-minute access token that authenticates as this end-user
            against your customer app. Every minting is audit-logged with your operator id.
          </p>
        </div>
        <form action={impersonate.bind(null, id, euid)} className="flex items-end gap-2">
          <label className="block flex-1 space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">
              Reason (optional, audit-logged)
            </span>
            <input
              type="text"
              name="reason"
              maxLength={280}
              placeholder="debugging ticket #42"
              className={inputCls}
            />
          </label>
          <SubmitButton pendingLabel="Minting…">Mint impersonation token</SubmitButton>
        </form>
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Passkeys" count={`(${detail.passkeys.length})`} />
        {detail.passkeys.length === 0 ? (
          <EmptyState variant="inline" title="No passkeys registered yet" />
        ) : (
          <>
            <Table minWidth="min-w-[40rem]">
              <THead>
                <TR>
                  <TH>Device</TH>
                  <TH>Credential id</TH>
                  <TH>Last used</TH>
                </TR>
              </THead>
              <TBody>
                {detail.passkeys.map((p) => (
                  <TR key={p.id} hover>
                    <TD className="font-medium">
                      {p.deviceName ?? (
                        <span className="font-normal text-[var(--color-muted-fg)]">—</span>
                      )}
                    </TD>
                    <TD mono className="max-w-[14rem] truncate">
                      {p.credentialId}
                    </TD>
                    <TD muted className="text-xs">
                      {p.lastUsedAt ? formatDateTime(p.lastUsedAt) : 'never'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Passkeys are managed by the end-user in your app. To remove one, the user deletes it
              there; erasing the account removes all of them. A passkey is not a device: it is a
              credential, and it takes no device slot.
            </p>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Recent impersonations"
          count={`(${detail.recentImpersonations.length})`}
        />
        {detail.recentImpersonations.length === 0 ? (
          <EmptyState variant="inline" title="No operator has impersonated this user" />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Operator</TH>
                <TH>Reason</TH>
                <TH>IP</TH>
              </TR>
            </THead>
            <TBody>
              {detail.recentImpersonations.map((r) => (
                <TR key={r.id} hover>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.startedAt)}</TD>
                  <TD mono className="max-w-[10rem] truncate">
                    {r.operatorUserId}
                  </TD>
                  <TD className="text-xs">
                    {r.reason ?? <span className="text-[var(--color-muted-fg)]">—</span>}
                  </TD>
                  <TD muted className="text-xs">
                    {r.ip ?? '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
