/**
 * End-user Subscriptions — what they are paying for, what they have paid, and
 * what has been issued to them.
 *
 * Read-only for now. Granting and cancelling from the panel need a tenant-scoped
 * route: the only grant path today is `POST /admin/applications/:id/
 * subscriptions`, held at the super-admin key on purpose because it is the one
 * billing write that CREATES entitlement on an assertion rather than following
 * money that moved.
 *
 * Two things this page has to say that the tables cannot:
 *
 *  - An empty list does not mean "not entitled". An Application with a default
 *    plan resolves FEATURE entitlements for users with no subscription at all,
 *    and no row exists to show for it.
 *  - A subscription carried by an inbound-only provider is managed somewhere
 *    else, and cancelling it here would be refused
 *    (`SUBSCRIPTION_MANAGED_EXTERNALLY`). Better said before there is a button
 *    than discovered by pressing one.
 */

import * as React from 'react';
import Link from 'next/link';
import { getApplication } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { getEndUserBilling } from '../shared';

/**
 * Providers that host no checkout and only receive events. A subscription on
 * one of these is authoritative somewhere else; Rekey mirrors it.
 */
const INBOUND_ONLY_PROVIDERS = new Set(['external']);

export default async function EndUserSubscriptionsPage({
  params,
}: {
  params: Promise<{ id: string; euid: string }>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const [billing, application] = await Promise.all([
    getEndUserBilling(id, euid),
    getApplication(id),
  ]);

  const defaultPlanSlug = application.billingConfig.defaultPlanSlug ?? null;
  const hasExternal = billing.subscriptions.some(
    (s) => s.provider !== null && INBOUND_ONLY_PROVIDERS.has(s.provider),
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeader
          title="Subscriptions"
          count={`(${billing.subscriptions.length})`}
          description="Most recent 100, newest first."
        />

        {hasExternal && (
          <Banner tone="info">
            One or more of these is carried by an inbound-only provider: your billing system owns it
            and posts events here. Rekey mirrors the status and refuses to cancel it locally —
            cancel it where it lives.
          </Banner>
        )}

        {billing.subscriptions.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No subscriptions"
            description={
              defaultPlanSlug
                ? `This user still resolves entitlements from the application's default plan (${defaultPlanSlug}). A default plan is read-time only, so there is no row here for it.`
                : 'This user has no subscription, and the application has no default plan, so they resolve no plan entitlements.'
            }
          />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH>Status</TH>
                <TH>Provider</TH>
                <TH>Renews</TH>
                <TH>Started</TH>
              </TR>
            </THead>
            <TBody>
              {billing.subscriptions.map((s) => (
                <TR key={s.id} hover>
                  <TD>
                    <span className="font-medium text-[var(--color-fg)]">{s.plan.name}</span>{' '}
                    <span className="font-mono text-xs text-[var(--color-muted-fg)]">
                      {s.plan.slug}
                    </span>
                    {s.beneficiaryOrgId && (
                      <Badge tone="info" className="ml-1.5">
                        team
                      </Badge>
                    )}
                    <div className="text-[11px] text-[var(--color-muted-fg)]">
                      {formatMoney(s.plan.amount, s.plan.currency)}
                      {s.plan.interval ? ` / ${s.plan.interval.toLowerCase()}` : ''}
                    </div>
                  </TD>
                  <TD>
                    <StatusPill status={s.status} />
                  </TD>
                  <TD muted className="text-xs">
                    {s.provider ?? '—'}
                    {s.provider !== null && INBOUND_ONLY_PROVIDERS.has(s.provider) && (
                      <div className="text-[11px]">managed externally</div>
                    )}
                  </TD>
                  <TD muted className="text-xs">
                    {s.cancelAt
                      ? `cancels ${formatDate(s.cancelAt)}`
                      : s.currentPeriodEnd
                        ? formatDate(s.currentPeriodEnd)
                        : '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {formatDate(s.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Payments"
          count={`(${billing.payments.length})`}
          description="Most recent 50, newest first."
        />
        {billing.payments.length === 0 ? (
          <EmptyState variant="inline" title="No payments recorded" />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>When</TH>
                <TH align="right">Amount</TH>
                <TH>Status</TH>
                <TH>Description</TH>
                <TH>Provider ref</TH>
              </TR>
            </THead>
            <TBody>
              {billing.payments.map((p) => (
                <TR key={p.id} hover>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(p.createdAt)}
                  </TD>
                  <TD align="right" mono className="tabular-nums">
                    {formatMoney(p.amount, p.currency)}
                  </TD>
                  <TD>
                    <StatusPill status={p.status} />
                  </TD>
                  <TD muted className="max-w-[12rem] truncate text-xs">
                    {p.description ?? '—'}
                  </TD>
                  <TD muted mono className="max-w-[12rem] truncate text-[11px]">
                    {p.providerPaymentId ?? '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Licenses"
          count={`(${billing.licenses.length})`}
          description="Keys issued to this end-user. Their per-machine activations are a separate capacity pool from devices."
          action={
            billing.licenses.length > 0 ? (
              <Link
                href={`/applications/${id}/licenses`}
                className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]"
              >
                Activations →
              </Link>
            ) : undefined
          }
        />
        {billing.licenses.length === 0 ? (
          <EmptyState variant="inline" title="No licenses issued" />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Key</TH>
                <TH>Plan</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
                <TH align="right">Seats</TH>
                <TH>Expires</TH>
              </TR>
            </THead>
            <TBody>
              {billing.licenses.map((l) => (
                <TR key={l.id} hover>
                  <TD mono>
                    {l.keyPrefix}…
                    {l.organizationId && (
                      <Badge tone="info" className="ml-1.5">
                        team
                      </Badge>
                    )}
                  </TD>
                  <TD muted className="text-xs">
                    {l.plan?.name ?? '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {l.kind.toLowerCase()}
                  </TD>
                  <TD>
                    <StatusPill status={l.status} />
                  </TD>
                  <TD align="right" muted className="text-xs tabular-nums">
                    {l.seatsAllowed ?? '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {l.expiresAt ? formatDate(l.expiresAt) : 'never'}
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
