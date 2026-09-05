/**
 * End-user detail shell: identity header, the conditions that apply to every
 * tab, and the tab strip.
 *
 * ## Why this is a layout and not a page
 *
 * This screen used to be one 900-line page rendering everything it knew about
 * an end-user as a single scroll — profile, auth events, subscriptions,
 * payments, credits, export, erase, impersonate, passkeys, impersonations. It
 * was a data dump, not a console: the shape answered "what do we store" when
 * the operator's question is "what do I do about this ticket". It also fetched
 * four endpoints on every render regardless of which part you came for, and had
 * nowhere to put the device, session and support actions the API has had since
 * the device series shipped.
 *
 * Splitting it into a layout plus six routed tabs gives each concern a
 * linkable URL, lets each tab fetch only what it renders, and leaves an obvious
 * place to add an action. The tabs are real route segments rather than client
 * state so that a support agent can paste "the devices tab for this user" into
 * a ticket.
 *
 * ## What stays here
 *
 * Only facts that are true on every tab: who this is, that they are erased,
 * and the navigation. `getEndUserDetail` is `React.cache`d per request, so the
 * header reading it here and a tab reading it below is one round trip, not two.
 */

import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { CopyLinkButton } from '@/components/CopyLinkButton';
import { Tab } from '@/components/Tab';
import { getEndUserDetail } from './shared';

export default async function EndUserLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; euid: string }>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const detail = await getEndUserDetail(id, euid);
  const isErased = detail.endUser.erasedAt !== null;
  const base = `/applications/${id}/end-users/${euid}`;

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        eyebrow={
          <Link
            href={`/applications/${id}/end-users`}
            className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            ← End-users
          </Link>
        }
        title={
          <span className="inline-flex items-center gap-2 text-lg">
            {detail.endUser.email}
            {isErased && (
              <Badge tone="danger" dot>
                erased
              </Badge>
            )}
          </span>
        }
        description={<span className="font-mono text-xs">{detail.endUser.id}</span>}
        action={<CopyLinkButton />}
      />

      {/* In the LAYOUT for the same reason the application's disabled banner is
          in its own: an erased user looks ordinary on Devices, on Credits and
          on Subscriptions, and an operator who landed on one of those directly
          would otherwise act on a tombstone without being told. */}
      {isErased && (
        <Banner tone="warning">
          This end-user has been erased (GDPR). Their PII and credentials are gone and they can no
          longer sign in. Financial records are retained but anonymized.
        </Banner>
      )}

      <div className="-mx-6">
        <nav aria-label="End-user sections" className="flex items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] px-6">
          <Tab href={base} exact>
            Overview
          </Tab>
          <Tab href={`${base}/subscriptions`}>Subscriptions</Tab>
          <Tab href={`${base}/devices`}>Devices</Tab>
          <Tab href={`${base}/credits`}>Credits</Tab>
          <Tab href={`${base}/security`}>Security</Tab>
          <Tab href={`${base}/data`}>Data &amp; privacy</Tab>
        </nav>
      </div>

      <div>{children}</div>
    </div>
  );
}
