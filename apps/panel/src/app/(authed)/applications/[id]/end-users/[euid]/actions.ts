'use server';

/**
 * Server actions for the end-user tabs.
 *
 * One file rather than one per tab, because several of them are reachable from
 * more than one place (releasing a device is a row action on Devices and part
 * of "reset devices" on Overview) and because a `'use server'` module may only
 * export async functions — constants shared with the pages live in `shared.ts`.
 *
 * Every action follows the same shape the rest of the panel uses: call the API,
 * turn a `PanelApiError` into a `?<x>Error=CODE` redirect the page renders as a
 * banner, and redirect to a success flag otherwise. Errors are surfaced by code
 * rather than by message so the copy stays the panel's and the API's wording
 * cannot leak an internal detail into the UI.
 */

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api, PanelApiError } from '@/lib/api';
import { cookieSecure } from '@/lib/cookie-secure';
import { IMPERSONATE_COOKIE, IMPERSONATE_COOKIE_MAX_AGE } from './shared';

function tabBase(applicationId: string, euid: string): string {
  return `/applications/${applicationId}/end-users/${euid}`;
}

function apiBase(applicationId: string, euid: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}`;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export async function grantCredits(
  applicationId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  const amount = Number(formData.get('amount') ?? 0);
  const reason = String(formData.get('reason') ?? 'GRANT');
  const description = String(formData.get('description') ?? '').trim();
  const base = `${tabBase(applicationId, euid)}/credits`;
  if (!Number.isInteger(amount) || amount === 0) {
    redirect(`${base}?creditError=AMOUNT`);
  }
  try {
    await api({
      method: 'POST',
      path: `${apiBase(applicationId, euid)}/credits/grant`,
      body: { amount, reason, description: description || undefined },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?creditError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?credited=1`);
}

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

/**
 * The impersonation token is sensitive — same treatment as the MFA setup
 * secret. It is stashed in a short-lived HttpOnly cookie scoped to this
 * end-user's pages and rendered server-side; it never goes in the URL.
 */
export async function impersonate(
  applicationId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  const reason = String(formData.get('reason') ?? '').trim();
  const base = `${tabBase(applicationId, euid)}/security`;
  try {
    const result = await api<{
      accessToken: string;
      accessTokenExpiresAt: string;
      impersonatedUser: { id: string; email: string };
    }>({
      method: 'POST',
      path: `${apiBase(applicationId, euid)}/impersonate`,
      body: { reason: reason || undefined },
    });
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, JSON.stringify(result), {
      httpOnly: true,
      sameSite: 'strict',
      secure: await cookieSecure(),
      // Scoped to the end-user, so it covers every tab under them and nothing
      // else. The reveal only renders on Security, which is where it is minted.
      path: tabBase(applicationId, euid),
      maxAge: IMPERSONATE_COOKIE_MAX_AGE,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?impError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?impersonated=1`);
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

export async function eraseUser(applicationId: string, euid: string): Promise<void> {
  const base = `${tabBase(applicationId, euid)}/data`;
  try {
    await api({
      method: 'DELETE',
      path: `${apiBase(applicationId, euid)}?erasure=true`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?eraseError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?erased=1`);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Grant a subscription with no payment provider behind it — an invoiced sale, a
 * comped account, a migration off a previous billing system.
 *
 * The note is optional to the API and required here. A comped subscription with
 * no stated reason is unauditable six months later, and the person who has to
 * reconstruct it is not the person granting it now.
 */
export async function grantSubscription(
  applicationId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  const planSlug = String(formData.get('planSlug') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const periodEnd = String(formData.get('currentPeriodEnd') ?? '').trim();
  const base = `${tabBase(applicationId, euid)}/subscriptions`;

  if (!planSlug) redirect(`${base}?grantError=PLAN_REQUIRED&grant=1`);
  if (!note) redirect(`${base}?grantError=NOTE_REQUIRED&grant=1`);

  let activated: boolean;
  try {
    const result = await api<{ activated: boolean }>({
      method: 'POST',
      path: `${apiBase(applicationId, euid)}/subscriptions`,
      body: {
        planSlug,
        note,
        // A date input gives YYYY-MM-DD; the API wants an instant. End of that
        // day UTC, so "ends on the 30th" means the 30th is still covered.
        ...(periodEnd ? { currentPeriodEnd: `${periodEnd}T23:59:59.000Z` } : {}),
      },
    });
    activated = result.activated;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?grantError=${encodeURIComponent(err.code)}&grant=1`);
    }
    throw err;
  }
  // `activated: false` is the idempotent no-op — the subscriber was already
  // entitled on this plan. Saying "granted" there would be a lie the operator
  // acts on, so the two outcomes get different banners.
  redirect(`${base}?granted=${activated ? '1' : 'already'}`);
}

export async function cancelSubscription(
  applicationId: string,
  euid: string,
  subId: string,
  formData: FormData,
): Promise<void> {
  const immediate = formData.get('immediate') === 'on';
  const base = `${tabBase(applicationId, euid)}/subscriptions`;
  let result: { cancelAt: string | null };
  try {
    result = await api<{ cancelAt: string | null }>({
      method: 'POST',
      path: `${apiBase(applicationId, euid)}/subscriptions/${encodeURIComponent(subId)}/cancel`,
      body: { atPeriodEnd: !immediate },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?cancelError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  // Report what HAPPENED, not what was asked for. `atPeriodEnd: true` is a
  // request; `cancelEffect` decides, and it schedules nothing for a
  // subscription with no period left — which is every open-ended grant. A
  // banner reading "keeps entitling until the end of the period" over an
  // account that just lost access is worse than no banner.
  const scheduled = result.cancelAt !== null && new Date(result.cancelAt) > new Date();
  redirect(`${base}?canceled=${scheduled ? 'period-end' : 'now'}`);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Release, block and unblock all return the device plus `sessionsRevoked`, and
 * the count is carried through to the banner on purpose: "released" on its own
 * does not tell an operator whether the person was signed out, which is the
 * half of the answer the support ticket is actually about.
 */
interface DeviceMutationResult {
  sessionsRevoked?: number;
}

async function deviceAction(
  applicationId: string,
  euid: string,
  deviceId: string,
  op: 'release' | 'block' | 'unblock',
  body?: unknown,
): Promise<void> {
  const base = `${tabBase(applicationId, euid)}/devices`;
  let result: DeviceMutationResult;
  try {
    result = await api<DeviceMutationResult>({
      method: 'POST',
      path: `${apiBase(applicationId, euid)}/devices/${encodeURIComponent(deviceId)}/${op}`,
      ...(body === undefined ? {} : { body }),
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?deviceError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  const revoked = typeof result?.sessionsRevoked === 'number' ? result.sessionsRevoked : 0;
  redirect(`${base}?device=${op}&revoked=${revoked}`);
}

export async function releaseDevice(
  applicationId: string,
  euid: string,
  deviceId: string,
): Promise<void> {
  await deviceAction(applicationId, euid, deviceId, 'release');
}

export async function blockDevice(
  applicationId: string,
  euid: string,
  deviceId: string,
  formData: FormData,
): Promise<void> {
  const reason = String(formData.get('reason') ?? '').trim();
  await deviceAction(applicationId, euid, deviceId, 'block', reason ? { reason } : {});
}

export async function unblockDevice(
  applicationId: string,
  euid: string,
  deviceId: string,
): Promise<void> {
  await deviceAction(applicationId, euid, deviceId, 'unblock');
}
