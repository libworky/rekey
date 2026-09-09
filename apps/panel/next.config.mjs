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
    // Client Router Cache off.
    //
    // `lib/api.ts` invalidates on every write, which fixes the case where the
    // operator caused the change. It does nothing for the case where somebody
    // ELSE did: a second operator, a webhook, an end-user signing in. Next's
    // defaults (dynamic 0, static 300) still let a revisited segment render
    // from a payload fetched minutes ago, and a support console showing a
    // stale device list or subscription state is worse than one that takes an
    // extra moment.
    //
    // The cost is a refetch on every navigation, which is exactly what this
    // console is for. It has no anonymous traffic, a handful of operators, and
    // every page is already dynamic and `no-store` — so the saving the Router
    // Cache offers was never large, and the staleness it bought was expensive.
    //
    // Raise these if the operator count ever makes the extra reads matter;
    // they interact with the API's rate limit (RATE_LIMIT_MAX), which has to
    // be sized for the traffic this setting produces.
    staleTimes: { dynamic: 0, static: 0 },
  },
};
export default nextConfig;
