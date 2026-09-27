# Device Usage and Compact Relay Controls

## Goal

Make device availability an explicit business state: an operator marks a device
in use when it is occupied by a charging customer, and releases it when it can
accept a new customer. Station status is derived from its linked device. Relay
controls remain a separate, compact technical demo.

## Scope

- Replace the `hold` terminology in the Charge Station API, contract, web API,
  and admin UI with `in use` / `release` terminology.
- Persist availability under the local device resource, never under a station.
- A station is **Available** only when its linked device is available and has
  current Core telemetry. An in-use or unavailable device makes its station
  unavailable for a new customer.
- An in-use linked device rejects a new payment reservation. Existing payments,
  charging sessions, telemetry, and relay commands continue unchanged.
- The Devices table shows a **Usage** state: **In use** or **Available**.
- Device detail shows one usage action: **Mark in use** or **Release device**.
- Render relays inside a compact collapsed **Relay demo** section. Each row
  contains its relay ID, current state, and one ON/OFF action; no usage copy or
  charging-state copy appears in that section.

## API and Data Design

`ManagedDevice` is keyed by the Core device ID and persists
`availability: AVAILABLE | IN_USE`. Migration 012 preserves the prior boolean
while migration 013 copies it into `managed_devices` and removes the temporary
station column. A linked station derives `AVAILABLE`, `IN_USE`, or
`UNAVAILABLE` from the managed device and live Core telemetry.

The admin device representation exposes `availability`. It provides:

- `POST /admin/devices/:deviceId/occupy` to set `inUse` to `true`.
- `POST /admin/devices/:deviceId/release` to set `inUse` to `false`.

No `/hold` endpoint or `held` response property remains. Payment reservation
locks the managed-device row before reading availability, so it serializes with
occupy/release. Relay commands do not inspect availability.

## UI Design

The Stations tab shows derived station status. The Devices tab independently
shows Core online state, charging session, and persisted availability. Device
detail begins with a usage summary and action; it separately states the current
charging session.

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

- API service and PostgreSQL concurrency tests prove occupy/release persistence,
  station derivation, serialized payment reservation rejection while in use,
  and relay ON remains allowed while in use.
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
