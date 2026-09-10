import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Conservative on purpose. `frame-ancestors 'none'` plus `X-Frame-Options`
// closes the clickjacking hole (this console was framable); `Referrer-Policy:
// no-referrer` stops a token-bearing URL leaking to a third party through the
// Referer header, which matters because reset / invite / MFA links arrive with
// their token in the query string.
//
// Deliberately NOT a full resource CSP. A console that loads nothing external
// can have one; this one loads Google Analytics when an operator sets a
// measurement id, and a `script-src 'self'` here would silently break it. A
// resource policy for this app needs its external origins enumerated and then
// verified in a browser, which is its own change.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (server.js + only the traced node_modules)
  // so the runtime image needs no `pnpm install` and ships none of the full
  // dependency tree — shrinks the image from ~1GB to a few hundred MB.
  output: 'standalone',
  // In a monorepo, trace deps from the workspace root so the standalone
  // bundle resolves hoisted/workspace packages correctly.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Workspace package transpilation isn't needed today (we only import types
  // from @rekey.dev/shared-types), but keep this here so future use of
  // workspace runtime helpers Just Works.
  transpilePackages: ['@rekey.dev/shared-types'],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  experimental: {
    // Required for `forbidden()` in lib/api.ts. Without it a 403 from the API
    // falls through to the generic error boundary, which tells the operator
    // the panel is broken and offers a "Try again" that can never succeed —
    // the UI could not distinguish "not yours" from "we're down".
    // `notFound()` is stable and needs no flag; `forbidden()` does.
    authInterrupts: true,
    // Page data always refetches; the shell around it does not.
    //
    // `dynamic: 0` is already Next's default, and it is what keeps a revisited
    // tab from rendering yesterday's device list. It is stated rather than
    // omitted because the value that matters sits next to it.
    //
    // `static` governs the shared shell — layouts and loading boundaries — and
    // it was briefly set to 0 here. That was a mistake worth recording. The
    // end-user screen is `[euid]/layout.tsx` (identity header plus the tab
    // strip) wrapping six routed tabs, so `static: 0` made every tab click
    // re-render and re-fetch the layout as well as the page. On a screen whose
    // shell calls `getEndUserDetail` and whose overview and security tabs each
    // pull THREE 200-row `security-events` scans to show twenty rows (the API
    // has no `actorId` filter, so the panel narrows in memory), that roughly
    // doubled the work per click and took the tab strip's instant render with
    // it. Request volume went from ~50/min to 210/min for the same browsing.
    //
    // 180s of shell reuse does not risk the staleness the 0 was meant to
    // prevent: `lib/api.ts` calls `revalidatePath('/', 'layout')` on every
    // write, so any operator action drops the layout immediately. What 180s
    // buys back is that navigating between tabs of the SAME record does not
    // re-fetch the record's header each time.
    //
    // These interact with the API's RATE_LIMIT_MAX, which has to be sized for
    // the traffic they produce.
    staleTimes: { dynamic: 0, static: 180 },
  },
};
export default nextConfig;
