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
    // BOTH of these must be non-zero. See README.md "Navigation performance"
    // before changing either — zero here does not mean "always fresh", it
    // means "prefetching is dead", and the console gets slower, not fresher.
    //
    // `dynamic` (Next's default is 0) is the lifetime of a prefetched page
    // segment. At 0 the router still ISSUES every prefetch a <Link> in the
    // viewport asks for, then throws the result away, so a click starts from
    // nothing and a client-side navigation is strictly slower than opening the
    // same URL in a new tab. That is measurable here: one tab click rendered
    // the page three to four times about a second apart — viewport prefetch,
    // hover prefetch, then the real navigation — each one a full render, none
    // reusable.
    //
    // `static` is the shared shell: layouts and loading boundaries. It was
    // briefly 0 too, which made every tab click re-render and re-fetch
    // `[euid]/layout.tsx` (identity header plus tab strip) as well as the page.
    // Request volume went from ~50/min to 210/min for the same browsing.
    //
    // Neither value risks showing an operator a stale write: `lib/api.ts`
    // calls `revalidatePath('/', 'layout')` on every non-GET, so any mutation
    // drops the whole tree immediately. These windows only cover the case
    // where somebody ELSE changed something, and 30s of that on a support
    // console is a better trade than a UI that stalls on every click.
    //
    // The reason the stall is so visible on the end-user tabs specifically:
    // the overview and security tabs each pull THREE 200-row `security-events`
    // scans to render twenty rows, because the API has no `actorId` filter and
    // the panel narrows in memory. Fix that and these windows matter less.
    //
    // These interact with the API's RATE_LIMIT_MAX, which has to be sized for
    // the traffic they produce.
    staleTimes: { dynamic: 30, static: 180 },
  },
};
export default nextConfig;
