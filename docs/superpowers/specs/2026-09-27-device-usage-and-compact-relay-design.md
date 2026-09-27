# Device Usage and Compact Relay Controls

## Goal

Make device usage an explicit business state: an operator marks a device as in
use when it is occupied by a charging customer, and releases it when it can
accept a new customer. Relay controls remain a separate, compact technical demo.

## Scope

- Replace the `hold` terminology in the Charge Station API, contract, web API,
  and admin UI with `in use` / `release` terminology.
- Keep one persisted station-level flag because a station has at most one linked
  device. Rename the model and database column to `device_in_use`.
- An in-use device rejects a new payment reservation. Existing payments,
  charging sessions, telemetry, and relay commands continue unchanged.
- The Devices table shows a **Usage** state: **In use** or **Available**.
- Device detail shows one usage action: **Mark in use** or **Release device**.
- Render relays inside a compact collapsed **Relay demo** section. Each row
  contains its relay ID, current state, and one ON/OFF action; no usage copy or
  charging-state copy appears in that section.

## API and Data Design

`Station.deviceInUse` is a non-null boolean with default `false`. Migration 012
renames `stations.device_hold` to `device_in_use` and preserves every existing
boolean value.

The admin device representation exposes `inUse: boolean`. It provides:

- `POST /admin/devices/:deviceId/occupy` to set `inUse` to `true`.
- `POST /admin/devices/:deviceId/release` to set `inUse` to `false`.

No `/hold` endpoint or `held` response property remains. Creating an order for
an in-use linked station fails with `Station device is in use`. Relay commands
do not inspect `deviceInUse`.

## UI Design

The Devices tab is operational first: device online state, charging session,
and usage state remain visible in the list. Device detail begins with a usage
summary and action; it separately states the current charging session.

Relay controls are visually subordinate in a native `<details>` disclosure
closed by default. Its summary is **Relay demo** and its compact rows preserve
accessible names such as **Turn on relay-1** and **Turn off relay-1**. An ON
command keeps the existing 15-minute default timer when no duration is passed.

## Error Handling

- An unknown or unlinked device continues to return the existing not-found
  response.
- Failed usage-state updates keep the prior UI state and show a usage-specific
  error message.
- Failed relay commands keep the prior telemetry display and show a relay-demo
  error message.

## Verification

- API service tests prove occupy/release persistence, payment-reservation
  rejection while in use, and relay ON remains allowed while in use.
- Controller and web API tests prove the new endpoint paths and response
  property.
- Dashboard tests prove usage labels/actions and the collapsed relay-demo
  disclosure with relay controls.
- Full API, web, contracts, simulator tests, and production build pass.

## Non-goals

- Usage state does not start, stop, or otherwise control a relay.
- Usage state is not inferred from telemetry or an active session; it remains
  an explicit operator-controlled business state.
- No relay scheduling functionality is added.
