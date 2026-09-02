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

## Webhook events

| Event | When |
|---|---|
| `device.registered` | A new fingerprint was registered, or a released device came back (`data.reactivated`). A sign-in from an already-active device emits nothing. |
| `device.released` | The end-user or an operator gave the slot back. `data.sessionsRevoked` says how many sessions ended with it; `data.releasedBy` is `end_user` or `operator`. |
| `device.blocked` | An operator blocked the device; its sessions were revoked. |
| `device.unblocked` | An operator lifted the block. The device is RELEASED. |
| `device.limit_reached` | A new device was refused. `data.devices` lists the active devices filling the cap. |

Every payload except `device.limit_reached` carries `data.device` with `id`,
`endUserId`, `fingerprint`, `label`, `status` and the timestamps. See
[webhooks.md](webhooks.md) for the envelope and signature.

## What lands in this series

This page describes the model and the service. The rest of the device work
ships as the following steps of the same series, and this page grows with
them:

1. **Device-bound sessions.** Session-minting endpoints accept
   `device: { fingerprint, label }`, the refresh token records the device, and
   the access token carries a `dev` claim. `authConfig.deviceBinding` says
   whether a fingerprint is optional or required.
2. **Management routes.** End-user (`/users/me/devices`), operator
   (`/tenant/applications/:id/end-users/:euid/devices`) and secret-key surfaces,
   plus `POST /licenses/deactivate` to give a seat back.
3. **License integration.** Activations link to the device the same
   fingerprint resolved to; released activations stop counting toward
   `seatsAllowed`; `max_devices` also bounds `PERPETUAL` and `TIMED` licenses.
