# `@rekey.dev/panel`

Next.js 15 admin panel for Rekey deployments.

> **For AI agents**: see [AGENTS.md](../../AGENTS.md).

## Run

```bash
REKEY_URL=http://localhost:3030 pnpm --filter @rekey.dev/panel dev
# → http://localhost:3031
```

Sign in with the deployment's `SUPER_ADMIN_KEY` (httpOnly cookie, never exposed to client JS).

## Build

```bash
pnpm --filter @rekey.dev/panel build
pnpm --filter @rekey.dev/panel start
```

## Required env

- `REKEY_URL` — base URL of the Rekey API

## Routes

- `/login` — paste admin key
- `/applications` — list (default landing)
- `/applications/[id]/{plans,coupons,api-keys}` — per-app inspection
- `/tenants` — tenant list

Mutations are intentionally not in v1 — operators create resources via `rekey <command>` (the CLI) or the admin API directly.

## Navigation performance

Two settings in `next.config.mjs` decide whether this console feels instant or
broken, and the intuitive value for both is the wrong one.

### `experimental.staleTimes` — zero does not mean "fresh"

```js
staleTimes: { dynamic: 30, static: 180 }
```

`dynamic` is how long a prefetched page segment stays usable. **Next's default
is 0, and 0 is actively harmful here.** The router still issues every prefetch
a `<Link>` in the viewport asks for — it just throws the result away. So the
click starts from nothing, and a client-side navigation ends up *slower than
opening the same URL in a new tab*. That symptom is the tell: if a fresh tab
loads instantly and clicking the same link hangs, this is why.

It is measurable. With `dynamic: 0`, one tab click on the end-user screen
rendered the page three to four times about a second apart — viewport prefetch,
hover prefetch, then the real navigation — every one a full server render, none
of them reusable.

`static` is the shared shell: layouts and `loading.tsx`. Setting it to 0 made
every tab click re-render and re-fetch `[euid]/layout.tsx` (the identity header
and the tab strip) on top of the page itself. Request volume went from about 50
per minute to 210 for the same browsing.

**Neither window risks showing an operator a stale write.** `lib/api.ts` calls
`revalidatePath('/', 'layout')` after every non-GET, so a mutation drops the
whole tree immediately. These windows only cover changes somebody *else* made —
a second operator, a webhook, an end-user signing in — and 30 seconds of that
is a better trade than a UI that stalls on every click.

If you are tempted to lower either value because a screen looks stale, the bug
is almost certainly a missing invalidation, not the cache. Check that the write
went through `api()`.

### Mutations must go through `api()`

`api()` is what calls `revalidatePath`. A mutation that bypasses it will land in
the database and leave the UI showing the old value — the redirect resolves to
the segment the operator already had, because the Router Cache keys on path and
ignores search params. The flash message renders; the data does not move.

This is why there is no per-action `revalidatePath` in this codebase. Adding one
is a sign something is being fetched the wrong way.

### Known cost: the end-user timeline

`getEndUserEvents` in `end-users/[euid]/shared.ts` issues **three 200-row
`security-events` scans to render twenty rows**, because
`GET /tenant/security-events` has no `actorId` filter and the panel narrows in
memory. The overview and security tabs pay it on every render, which is why
those two tabs are the ones that feel slow.

The fix is an `actorId`/`endUserId` filter on that endpoint, not more caching
here.

### Rate limiting

These settings decide how many API calls a browsing session makes, and the API
throttles on `RATE_LIMIT_MAX` (default 100 per 60s, keyed by API key or, for
panel traffic, by the operator's IP). A panel session presents a session token
rather than an API key, so it lands in the IP bucket and one operator can spend
the whole window alone. If you make navigation chattier, check that limit moves
with it.
