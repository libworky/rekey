/**
 * End-user Overview — the triage tab.
 *
 * The question this screen answers is "what is going on with this account",
 * asked by someone holding a support ticket. So it is four numbers and a
 * timeline, each linking to the tab where you can act on it, rather than a wall
 * of every field Rekey stores. The detail lives one click away in the tab it
 * belongs to.
 *
 * The tiles are the four things a ticket is ever about: what they are paying
 * for, how many machines they are on, what they have left to spend, and whether
 * they can get in.
 */

import * as React from 'react';
import Link from 'next/link';
import { getApplication } from '@/lib/api';
import { humanizeEventType } from '@/lib/security-events';
import { formatDate, formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import {
  getEndUserBilling,
  getEndUserCredits,
  getEndUserDetail,
  getEndUserDeviceCounts,
  getEndUserEvents,
  provenanceFrom,
  LOGIN_LOCK_THRESHOLD,
  LOGIN_LOCK_MINUTES,
} from './shared';

/** Statuses that mean "this subscriber is entitled right now". */
const LIVE_SUBSCRIPTION = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING']);

const OVERVIEW_EVENTS_SHOWN = 5;

export default async function EndUserOverviewPage({
  params,
}: {
  params: Promise<{ id: string; euid: string }>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const [detail, application, billing, credits, devices, events] = await Promise.all([
    getEndUserDetail(id, euid),
    getApplication(id),
    getEndUserBilling(id, euid),
    getEndUserCredits(id, euid),
    getEndUserDeviceCounts(id, euid),
    getEndUserEvents(id, euid),
  ]);

  const base = `/applications/${id}/end-users/${euid}`;
  const provenance = provenanceFrom(events);

  const lockedUntil = detail.endUser.lockedUntil ? new Date(detail.endUser.lockedUntil) : null;
  const lockedNow = lockedUntil !== null && lockedUntil > new Date();

  const live = billing?.subscriptions.find((s) => LIVE_SUBSCRIPTION.has(s.status));
  /**
   * Free-tier fallback: the plan whose FEATURE entitlements apply to a user
   * with no subscription. Read-time only — no Subscription row stands behind
   * it, which is exactly why an operator looking at an empty subscriptions list
   * needs telling that the user is nonetheless on a plan.
   *
   * This is the plan, not the resolved entitlement set: per-subscription
   * overrides are not in this response and are not reflected here.
   */
  const defaultPlanSlug = application.billingConfig.defaultPlanSlug ?? null;

  const planValue = billing === null ? '—' : live ? live.plan.name : (defaultPlanSlug ?? 'None');
  const planFooter = live
    ? `${formatMoney(live.plan.amount, live.plan.currency)}${
        live.plan.interval ? ` / ${live.plan.interval.toLowerCase()}` : ''
      } · ${live.status.toLowerCase()}`
    : billing === null
      ? 'billing could not be read'
      : defaultPlanSlug
        ? "the application's default plan, no subscription"
        : 'no subscription and no default plan';

  return (
    <div className="space-y-5">
      <Card className="space-y-3">
        <SectionHeader
          title="Profile"
          action={
            <span className="text-xs text-[var(--color-muted-fg)]">
              Joined {formatDate(detail.endUser.createdAt)}
            </span>
          }
        />
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-[var(--color-muted-fg)]">Email</dt>
            <dd className="flex items-center gap-2 text-[var(--color-fg)]">
              <span className="truncate">{detail.endUser.email}</span>
              {detail.endUser.emailVerified ? (
                <Badge tone="success" dot>
                  verified
                </Badge>
              ) : (
                <Badge tone="warning">unverified</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Role</dt>
            <dd>
              <Badge tone="neutral" mono>
                {detail.endUser.role}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-fg)]">Origin</dt>
            <dd>
              {/* A hit is a fact. A miss is NOT "signed up": `provenanceFrom`
                  returns null just as readily because the operator is a MEMBER
                  and cannot read security events at all, or because the
                  creation fell outside the scanned window on a busy
                  application. Asserting "sign-up" there would state the exact
                  thing this field exists to stop somebody assuming — and would
                  do it every single time for a MEMBER. */}
              {provenance ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Badge tone="info">billing event</Badge>
                  <span className="text-xs text-[var(--color-muted-fg)]">
                    {provenance.provider ? `${provenance.provider}, ` : ''}
                    {formatDate(provenance.at)}
                  </span>
                </span>
              ) : (
                <span
                  className="text-xs text-[var(--color-muted-fg)]"
                  title={
                    events === null
                      ? 'Listing security events requires the OWNER or ADMIN workspace role, so this cannot be determined for your role.'
                      : "No creation event for this end-user in the application's most recent events. That is not evidence they signed up — the record may simply be older than the scanned window."
                  }
                >
                  {events === null ? 'not visible to your role' : 'not in the scanned window'}
                </span>
              )}
            </dd>
          </div>
        </dl>
        {provenance && (
          <p className="text-[11px] text-[var(--color-muted-fg)]">
            Created from a billing event rather than a sign-up, so it may carry no password and an
            address verified on the provider&apos;s word. That is expected, not a broken
            registration.
          </p>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile title="Plan" value={planValue} footer={planFooter} href={`${base}/subscriptions`} />
        {/* A tile shows "—" rather than "0" when the read failed. Zero is a
            statement about the account; the request having failed is not. */}
        <StatTile
          title="Devices"
          value={devices === null ? '—' : String(devices.active)}
          footer={
            devices === null
              ? 'device list could not be read'
              : devices.total === devices.active
                ? plural(devices.active, 'active device')
                : `${devices.active} active of ${devices.total} known${
                    devices.blocked > 0 ? ` · ${devices.blocked} blocked` : ''
                  }`
          }
          href={`${base}/devices`}
          tone={devices !== null && devices.blocked > 0 ? 'warn' : undefined}
        />
        <StatTile
          title="Credits"
          value={credits === null ? '—' : String(credits.balance)}
          footer={
            credits === null
              ? 'credit balance could not be read'
              : plural(credits.ledger.length, 'recent entry', 'recent entries')
          }
          href={`${base}/credits`}
        />
        <StatTile
          title="Sign-in"
          value={lockedNow ? 'Locked' : 'OK'}
          footer={
            lockedNow
              ? `locked until ${formatDateTime(lockedUntil)}`
              : detail.endUser.failedSignInAttempts > 0
                ? `${detail.endUser.failedSignInAttempts} of ${LOGIN_LOCK_THRESHOLD} failures this window`
                : `no failures · ${LOGIN_LOCK_THRESHOLD} locks it for ${LOGIN_LOCK_MINUTES} min`
          }
          href={`${base}/security`}
          tone={lockedNow ? 'warn' : undefined}
        />
      </div>

      <section className="space-y-3">
        <SectionHeader
          title="Recent activity"
          description="Newest first, across events this user caused and events an operator caused on them."
          action={
            <Link
              href={`${base}/security`}
              className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]"
            >
              All activity →
            </Link>
          }
        />
        {events === null ? (
          <EmptyState
            variant="inline"
            title="Activity is not visible to your role"
            description="Listing security events requires the OWNER or ADMIN workspace role."
          />
        ) : events.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No recorded events"
            description="Nothing for this user in the application's most recent events. Failed sign-ins are counted in Redis and never written as events, so they cannot appear here."
          />
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-[var(--color-border)]">
              {events.slice(0, OVERVIEW_EVENTS_SHOWN).map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">
                    {humanizeEventType(e.type)}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-muted-fg)]">
                    {formatDateTime(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

/** Compact metric tile — same pattern as the Revenue and app Overview tiles. */
function StatTile({
  title,
  value,
  footer,
  href,
  tone,
}: {
  title: string;
  value: string;
  footer: string;
  href: string;
  tone?: 'warn' | undefined;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-neutral-400 dark:hover:border-neutral-600"
    >
      <span className="text-xs text-neutral-600 dark:text-neutral-500">{title}</span>
      <span
        className={`truncate text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
        }`}
        title={value}
      >
        {value}
      </span>
      <span className="text-xs leading-snug text-[var(--color-muted-fg)]">{footer}</span>
    </Link>
  );
}
