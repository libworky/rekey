# Devices

The machines an end-user signs in from, as something Rekey can name, count
and revoke.

## Why a device is its own row

Rekey has always known about machines in one place: `POST /api/v1/licenses/verify`
records a `machineFingerprint` against the license it verified, and a `SEATS`
license refuses once `seatsAllowed` fingerprints have been seen. That made a
device a fact about a license, not about a person. Three things followed:

- An end-user on a subscription plan — no license — could not bind a machine at
  all. There was nothing to bind it to.
- A seat, once taken, could never be given back. Re-imaging a laptop burned a
  seat forever.
- Nothing about a session said which machine minted it. "Sign out this laptop"
  was not a request the API could express.

A `Device` is the missing noun: one row per `(application, end-user,
fingerprint)`, with a status, a label, and first/last-seen timestamps. Sessions
and license activations point at it.

## The fingerprint

The fingerprint is computed by **your** client and is opaque to Rekey — the
same contract `machineFingerprint` has had since licenses shipped. Rekey never
derives, parses or compares its parts; it stores the string and matches on it.
Hash whatever you consider "the same machine" (hostname, OS install id, MAC,
disk serial), keep it stable across launches, and keep it between 8 and 256
characters.

Uniqueness is **per end-user**. The same fingerprint under two accounts is two
devices. Cross-account reuse of a fingerprint is recorded in the security-events
trail (`user.device_registered` carries the device id; the operator device
list shows the fingerprint), but it is never refused: a shared family PC with
two accounts is not an attack, and the database is the wrong place to decide
that it is.

## Lifecycle

```
                 sign-in / verify
   (none) ──────────────────────────▶ ACTIVE ◀──────────────┐
                                        │                    │ sign-in / verify
                    release             │                    │ (if under the limit)
                                        ▼                    │
                                     RELEASED ───────────────┘
                                        │
                       block            │   block
                                        ▼
                                     BLOCKED ──── unblock ───▶ RELEASED
```

- **ACTIVE** holds a slot against the end-user's device limit. A sign-in from
  an ACTIVE device refreshes `lastSeenAt` and never fails on the limit.
- **RELEASED** holds no slot. The end-user (`DELETE /users/me/devices/:id`) or an
  operator gave it back, and every session minted on it was revoked in the
  same transaction. A later sign-in from the same fingerprint reactivates the
  row in place — subject to the limit — rather than creating a second one.
- **BLOCKED** is an operator decision. Sign-in from that fingerprint is refused
  with `DEVICE_BLOCKED` until an operator unblocks it, and the end-user cannot
  release their way out of it. Unblocking returns the device to RELEASED, not
  ACTIVE: it takes a slot again only when it next signs in, and only if the
  limit allows, so unblocking is never a way past `max_devices`.

Rows are never deleted by the API. A released device is history the operator
can still see.

## The device limit is an entitlement

There is no `maxDevices` setting on the Application. The cap is the
`max_devices` **FEATURE** entitlement on a plan:

```json
{ "kind": "FEATURE", "key": "max_devices", "valueType": "INT", "value": "3" }
```

It resolves through the ordinary entitlement union — the MAX across the
end-user's active subscriptions, with the Application's default plan supplying
the free tier — so a plan upgrade raises the cap without anyone touching a
device row, and a downgrade lowers it for the *next* device rather than evicting
one. An end-user whose plans grant no `max_devices` feature is uncapped, which
is also what every Application sees until it configures one: adding devices to
Rekey changed nothing for a deployment that has not asked for a limit.

The check-then-insert runs under a per-`(application, end-user)` advisory lock,
the same way `licenses/verify` serialises seat allocation, so ten concurrent
first sign-ins from ten new machines register exactly `max_devices` of them.

When a new device is refused, the refusal carries the ACTIVE devices that fill
the cap — id, label, first and last seen — so your client can show the user
which machine to release rather than a dead end.

## Binding a session to a device

Every endpoint that mints a session — `POST /auth/sign-in`, `/auth/sign-up`,
`/auth/mfa-verify`, `/auth/refresh`, `/auth/oauth/:provider/callback`,
`/auth/magic-link/verify`, `/auth/passkey/authenticate/complete` — accepts an
optional `device` object:

```json
{ "email": "…", "password": "…", "device": { "fingerprint": "sha256:…", "label": "Work laptop" } }
```

When present, the device is registered (or refreshed) through the limit
described above **before** any token is issued, so a machine over the cap
never gets a session. The result is a session that knows its machine:

- `AuthResult.deviceId` names the device.
- The access token carries a `dev` claim with the same id. It is a claim, not
  an authorization: `requireUserSession` surfaces it as `request.deviceId`,
  and anything that needs to trust it resolves the row and checks `status`,
  the way `oid` is re-confirmed against membership.
- The refresh token records `deviceId`, and every rotation carries it.
- `GET /auth/sessions` lists `deviceId` per session, so "sign out this
  laptop" is `DELETE /auth/sessions/:id` for the session on that device — or
  release the device, which revokes every session on it at once.

Clients that send no `device` see no change at all: `deviceId` is `null`,
there is no claim, and nothing is registered. Browser SDKs never send one.

### Refresh and the stolen-token case

A chain bound at sign-in stays bound. If a refresh **also** carries a
`device`, it must be the same fingerprint — a refresh token presented from a
different machine is treated like a replayed one: `401
REFRESH_TOKEN_DEVICE_MISMATCH`, and every session for that user is revoked. A
chain that was never bound may be bound by the first refresh that identifies
itself (a client that started sending fingerprints mid-session), and one that
stays unbound is left alone.

### Requiring a binding

`authConfig.deviceBinding` is `optional` by default. Set it to `required` and
the primary sign-in flows refuse without a `device` (`400
DEVICE_FINGERPRINT_REQUIRED`). Refresh is never gated by it, so flipping the
switch on a running Application does not sign anyone out; it changes what the
next sign-in needs. Set it from the panel, `PATCH
/tenant/applications/:id/auth-config`, or the `update_auth_config` MCP tool.

### Errors a client should handle

| Code | Status | When | `details` |
|---|---|---|---|
| `DEVICE_LIMIT_REACHED` | 403 | A new (or released) device would exceed `max_devices`. | `{ limit, devices: [{ id, label, firstSeenAt, lastSeenAt }] }` — the active devices to release. |
| `DEVICE_BLOCKED` | 403 | An operator blocked this fingerprint. | — |
| `DEVICE_FINGERPRINT_REQUIRED` | 400 | `deviceBinding` is `required` and the body had no `device`. | — |
| `REFRESH_TOKEN_DEVICE_MISMATCH` | 401 | A bound chain was refreshed from a different fingerprint. All sessions revoked. | — |

## Managing devices

Three surfaces over one service. Every one scopes by (application, end-user)
and answers 404 across either boundary, so a device id from another user or
another Application is indistinguishable from a typo.

| Surface | Credential | Routes |
|---|---|---|
| End-user | publishable key + user JWT | `GET /api/v1/users/me/devices` (redacted: no IP, no operator notes) · `DELETE /api/v1/users/me/devices/:id` |
| Your backend | secret key (`auth:read` / `auth:write`) | `GET /api/v1/devices?endUserId=` · `POST /api/v1/devices/:id/release` `{ endUserId }` |
| Operator | panel session | `GET …/end-users/:euid/devices` · `POST …/devices/:id/release` · `POST …/devices/:id/block` `{ reason? }` · `POST …/devices/:id/unblock` under `/api/v1/tenant/applications/:id` |

**Release** gives the slot back and revokes every session minted on the
device, in one transaction — including the caller's own session when it is
the same device. It is idempotent. A blocked device is not its owner's to
release.

**Block** and **unblock** are operator decisions and exist on the operator
surface only. The `reason` never reaches the end-user, who sees
`DEVICE_BLOCKED` and nothing else. Unblocking returns the device to RELEASED.

Node SDK: `rekey.devices.list(endUserId, { status })` and
`rekey.devices.release(deviceId, endUserId)` for the secret-key surface.

## License seats and devices

A license activation is a machine's hold on a seat, keyed by the same
opaque fingerprint. Since 2.1.0 it has always been possible to *take* a seat
(`POST /licenses/verify`); it is now possible to give one back:

- `POST /api/v1/licenses/deactivate` `{ key, machineFingerprint }` — the
  customer's software calls it before a re-image or on uninstall. Same
  deterministic body as verify (`ok: false` + `reason` for an unknown, revoked
  or expired key, never an HTTP error), idempotent (`released: false` when the
  machine held no seat). SDK: `rekey.licenses.deactivate(...)`.
- Operators see every activation at `GET …/licenses/:licenseId/activations`
  (`releasedAt` marks freed seats) and can release one at
  `POST …/licenses/:licenseId/activations/:activationId/release`.

A released activation stops counting toward `seatsAllowed`; the next verify
from the same machine reactivates it in place rather than inserting a second
row. When the license holder has a Device with the same fingerprint, the
activation's `deviceId` points at it, so the seat list and the device list
describe the same machines. Emits `license.deactivated`.

## Webhook events

| Event | When |
|---|---|
| `device.registered` | A new fingerprint was registered, or a released device came back (`data.reactivated`). A sign-in from an already-active device emits nothing. |
| `device.released` | The end-user or an operator gave the slot back. `data.sessionsRevoked` says how many sessions ended with it; `data.releasedBy` is `end_user` or `operator`. |
| `device.blocked` | An operator blocked the device; its sessions were revoked. |
| `device.unblocked` | An operator lifted the block. The device is RELEASED. |
| `device.limit_reached` | A new device was refused. `data.devices` lists the active devices filling the cap. |
| `license.deactivated` | A machine gave back its license seat — `POST /licenses/deactivate` or an operator release (`data.releasedBy`). `data.license` and `data.machineFingerprint`. |

Every payload except `device.limit_reached` carries `data.device` with `id`,
`endUserId`, `fingerprint`, `label`, `status` and the timestamps. See
[webhooks.md](webhooks.md) for the envelope and signature.

### The limit also bounds licenses

A `SEATS` license carries its own cap (`seatsAllowed`, what was bought). A
`PERPETUAL` or `TIMED` license held by an end-user is bounded by that user's
`max_devices` entitlement, when their plans grant one — the same number that
bounds their sessions — and refuses further machines with
`seats_exhausted`. Holders whose plans grant no such feature stay uncapped,
as every deployment was before the entitlement existed. Org-pooled licenses
have no single end-user to resolve for and follow only `seatsAllowed`.

## What is still to come

Secret-key entitlement and user lookup for backends that hold no user token,
and MCP tools over these routes.
