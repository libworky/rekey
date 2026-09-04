/**
 * End-user Subscriptions — what they are paying for, what they have paid, and
 * what has been issued to them.
 *
 * An OWNER or ADMIN can grant a subscription here, and cancel one. Granting was
 * super-admin-only until the tenant routes existed, because it is the one
 * billing write that CREATES entitlement on an assertion rather than following
 * money that demonstrably moved — so two things gate the affordance: the
 * operator's role, and `TENANT_SUBSCRIPTION_GRANTS`, which a deployment that
 * sells to the workspaces it hosts sets to `disabled`. Both are checked here
 * for the button and again by the API for the action.
 *
 * Three things this page has to say that the tables cannot:
 *
 *  - An empty list does not mean "not entitled". An Application with a default
 *    plan resolves FEATURE entitlements for users with no subscription at all,
 *    and no row exists to show for it.
 *  - A subscription carried by an inbound-only provider is managed somewhere
 *    else, and cancelling it here would be refused
 *    (`SUBSCRIPTION_MANAGED_EXTERNALLY`). Said in place of the button rather
 *    than discovered by pressing one.
 *  - Granting is not charging. "Grant subscription" reads to a support agent
 *    like "bill them for a subscription", and the two are opposite mistakes, so
 *    the dialog says outright that no money is collected.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  apiGet,
  getApplication,
  getMe,
  getSubscriptionGrantsMode,
  type PlanRow,
} from '@/lib/api';
import { cancelEffect } from '@rekey.dev/shared-types';
import type { Page } from '@/lib/paginate';
import { formatDate, formatDateTime } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/Field';
import { SubmitButton } from '@/components/SubmitButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { cancelSubscription, grantSubscription } from '../actions';
import { getEndUserBilling, type SubscriptionRow } from '../shared';

/**
 * Providers that host no checkout and only receive events. A subscription on
 * one of these is authoritative somewhere else; Rekey mirrors it.
 */
const INBOUND_ONLY_PROVIDERS = new Set(['external']);

/** Statuses a cancel can still act on. */
const CANCELLABLE = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING', 'PENDING']);

const GRANT_ERR: Record<string, string> = {
  PLAN_REQUIRED: 'Pick a plan.',
  NOTE_REQUIRED: 'Say why this is being granted — it goes in the audit trail.',
  PLAN_NOT_FOUND: 'That plan no longer exists in this Application.',
  BILLING_ORGANIZATION_REQUIRED:
    'This Application bills per organization, so a grant has to name one. Granting to an individual is not possible while the billing subject is “org”.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can grant a subscription.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
  TENANT_SUBSCRIPTION_GRANTS_DISABLED:
    'Operator grants are switched off on this deployment (TENANT_SUBSCRIPTION_GRANTS).',
  VALIDATION_ERROR: 'Check the period end — it has to be in the future.',
};

const CANCEL_ERR: Record<string, string> = {
  SUBSCRIPTION_NOT_FOUND: 'That subscription no longer exists for this end-user.',
  SUBSCRIPTION_MANAGED_EXTERNALLY:
    'This subscription is owned by your own billing system. Cancel it there; Rekey will mirror the event.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can cancel a subscription.',
  PROVIDER_CANCEL_FAILED:
    'The payment provider refused the cancellation. Check the provider dashboard and the Activity log.',
};

export default async function EndUserSubscriptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const granted = typeof sp.granted === 'string' ? sp.granted : undefined;
  const canceled = typeof sp.canceled === 'string' ? sp.canceled : undefined;
  const grantError = typeof sp.grantError === 'string' ? sp.grantError : undefined;
  const cancelError = typeof sp.cancelError === 'string' ? sp.cancelError : undefined;

  const [billing, application, me, grantsMode] = await Promise.all([
    getEndUserBilling(id, euid),
    getApplication(id),
    getMe(),
    getSubscriptionGrantsMode(),
  ]);

  // Both, not either: hiding the affordance is a usability choice, and the API
  // enforces the same floor on its own.
  const canGrant =
    grantsMode === 'enabled' && (me.activeRole === 'OWNER' || me.activeRole === 'ADMIN');

  // Only fetched when there is a form to fill. The picker offers active plans;
  // the API accepts withdrawn ones too, but offering the whole historical
  // catalogue in a dropdown is how the wrong one gets picked.
  const plans = canGrant
    ? await apiGet<Page<PlanRow>>(
        `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans?limit=100`,
        { interruptOnAccessError: false },
      )
        .then((p) => p.items.filter((pl) => pl.active))
        .catch(() => [] as PlanRow[])
    : [];

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
          action={
            canGrant ? (
              <GrantForm applicationId={id} euid={euid} plans={plans} error={grantError} />
            ) : undefined
          }
        />

        {granted === '1' && (
          <Banner tone="success">
            Subscription granted. The plan&apos;s entitlements are live and{' '}
            <code className="font-mono">subscription.activated</code> has been announced to your
            webhook endpoints.
          </Banner>
        )}
        {granted === 'already' && (
          <Banner tone="info">
            Nothing to do — this end-user was already entitled on that plan. Granting again does not
            extend a live period; to move it to a new term, cancel it and grant again.
          </Banner>
        )}
        {canceled === 'period-end' && (
          <Banner tone="success">
            Cancellation scheduled. The subscription keeps entitling until the end of the paid
            period.
          </Banner>
        )}
        {canceled === 'now' && (
          <Banner tone="success">Subscription cancelled immediately. Entitlements are gone.</Banner>
        )}
        {grantError && (
          <Banner tone="error">{GRANT_ERR[grantError] ?? grantError}</Banner>
        )}
        {cancelError && (
          <Banner tone="error">{CANCEL_ERR[cancelError] ?? cancelError}</Banner>
        )}

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
                {canGrant && <TH align="right"> </TH>}
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
                  {canGrant && (
                    <TD align="right">
                      <CancelAction applicationId={id} euid={euid} subscription={s} />
                    </TD>
                  )}
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

/**
 * Grant a subscription with nothing behind it but the operator's word.
 *
 * The confirmation copy says what it is NOT — no money is collected, nothing is
 * charged — because "grant subscription" reads to a support agent like
 * "charge them for a subscription", and the two are opposite mistakes.
 */
function GrantForm({
  applicationId,
  euid,
  plans,
  error,
}: {
  applicationId: string;
  euid: string;
  plans: PlanRow[];
  error?: string | undefined;
}): React.JSX.Element {
  if (plans.length === 0) {
    return (
      <span className="text-xs text-[var(--color-muted-fg)]">
        No active plans to grant.{' '}
        <Link
          href={`/applications/${applicationId}/plans`}
          className="underline underline-offset-2 hover:text-[var(--color-fg)]"
        >
          Create one
        </Link>
      </span>
    );
  }
  return (
    <Modal
      modalKey="grant"
      title="Grant a subscription"
      description="Activates a subscription against a plan with no payment provider behind it — an invoiced sale, a bank transfer, a comped account, a migration off a previous billing system. No money is collected and nothing is charged."
      trigger="Grant subscription"
    >
      <form action={grantSubscription.bind(null, applicationId, euid)} className="space-y-3">
        {error && <Banner tone="error">{GRANT_ERR[error] ?? error}</Banner>}
        <Field label="Plan" required hint="Active plans only. Withdrawn plans can still be granted through the API.">
          <select name="planSlug" required defaultValue="" className={inputCls}>
            <option value="" disabled>
              Pick a plan…
            </option>
            {plans.map((p) => (
              <option key={p.id} value={p.slug}>
                {p.name} — {formatMoney(p.amount, p.currency)} / {p.interval.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Reason"
          required
          hint="Recorded on the subscription and in the security log. Required here even though the API allows it to be omitted: a comped subscription with no stated reason is unauditable six months later."
        >
          <input
            type="text"
            name="note"
            required
            maxLength={500}
            placeholder="paid by bank transfer, INV-4012"
            className={inputCls}
          />
        </Field>
        <Field
          label="Period ends"
          hint="Optional, and open-ended if you leave it blank — a grant does not renew and nothing expires it, so “comp this account” means comped until somebody cancels. Set a date to time-box it. Note that cancelling an open-ended grant takes effect immediately, because there is no paid period left to run out."
        >
          <input type="date" name="currentPeriodEnd" className={inputCls} />
        </Field>
        <SubmitButton pendingLabel="Granting…">Grant subscription</SubmitButton>
      </form>
    </Modal>
  );
}

/**
 * Cancel one subscription.
 *
 * The dialog has to say which cancel it is. A provider-backed subscription is
 * cancelled at the provider; a granted one ends locally; one carried by an
 * inbound-only provider cannot be cancelled here at all, and saying so beats
 * letting the operator discover it from a 409.
 */
function CancelAction({
  applicationId,
  euid,
  subscription,
}: {
  applicationId: string;
  euid: string;
  subscription: SubscriptionRow;
}): React.JSX.Element | null {
  if (!CANCELLABLE.has(subscription.status)) return null;

  if (subscription.provider !== null && INBOUND_ONLY_PROVIDERS.has(subscription.provider)) {
    return (
      <span
        className="text-xs text-[var(--color-muted-fg)]"
        title="Your billing system owns this subscription. Cancel it there and Rekey will mirror the event."
      >
        managed externally
      </span>
    );
  }

  // `cancelEffect` is exported from shared-types for exactly this: one rule,
  // read by the server that applies it and by the UI that has to describe it
  // BEFORE the call is made. Guessing here is how the copy and the behaviour
  // drift apart — and they would have, immediately: a granted subscription is
  // open-ended by default, so `currentPeriodEnd` is null and cancelling it
  // stops access on the spot. "Cancels at the end of the paid period" would
  // have been a promise the button breaks the moment it is pressed.
  const effect = cancelEffect(subscription);
  const timing =
    effect === 'period-end'
      ? `It keeps entitling until ${
          subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : 'the end of the paid period'
        }, which is what the end-user's own self-service cancel does to the same row.`
      : 'There is no paid period left to run out, so access stops immediately. Entitlements are revoked the moment you confirm.';
  const where =
    subscription.provider === null
      ? 'No payment provider is behind this subscription, so it ends locally.'
      : `This subscription is carried by ${subscription.provider}, so it is cancelled there too.`;

  return (
    <form action={cancelSubscription.bind(null, applicationId, euid, subscription.id)}>
      <ConfirmButton
        title={effect === 'period-end' ? 'Cancel at the end of the period?' : 'Cancel immediately?'}
        confirm={`${where} ${timing}`}
        confirmLabel={effect === 'period-end' ? 'Cancel at period end' : 'Cancel now'}
      >
        Cancel
      </ConfirmButton>
    </form>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
