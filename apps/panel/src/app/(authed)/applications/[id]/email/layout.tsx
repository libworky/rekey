/**
 * Email shell: one tab strip over four responsibilities.
 *
 * The page this replaces stacked three unrelated things — transport status,
 * BYO credentials, and the template list — into one scroll, put the send log on
 * a separate page reachable only by a link buried in the transport card, and
 * offered no way to stop email going out at all. The question an operator
 * arrives with is usually one of four, and each now has a place:
 *
 *   Settings       is mail on, who is it from, and which transport carries it
 *   Templates      what each email says, and whether it is sent at all
 *   Delivery       what actually happened to the last N sends
 *   Suppressions   who we must not email, and why
 *
 * The per-event editor stays at `email/[eventKey]`. A static segment wins over
 * a dynamic sibling in the App Router, so `templates` and `suppressions` are
 * not swallowed by it.
 */

import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Tab } from '@/components/Tab';

export default async function EmailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const base = `/applications/${id}/email`;

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        title="Email"
        description="Transactional mail this Application sends to its end-users. Workspace mail — operator invitations and the like — is separate and is not affected by anything here."
      />

      <div className="-mx-6">
        <nav
          aria-label="Email sections"
          className="flex items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] px-6"
        >
          <Tab href={base} exact>
            Settings
          </Tab>
          <Tab href={`${base}/templates`}>Templates</Tab>
          <Tab href={`${base}/logs`}>Delivery</Tab>
          <Tab href={`${base}/suppressions`}>Suppressions</Tab>
        </nav>
      </div>

      <div>{children}</div>
    </div>
  );
}
