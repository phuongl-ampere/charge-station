# Charge Station Architecture

This is the current runtime architecture. It supersedes older design notes when
they describe manual Device hold/release or assume Core telemetry is returned
in one page.

## System boundary

```text
Admin browser / customer QR browser
             │ HTTPS + Socket.IO
             ▼
       Next.js web (3100)
             │ local HTTP API
             ▼
      NestJS API (4000) ─────── PostgreSQL (5432)
             │                         │
             │ OAuth REST              │ stations, connectors, orders,
             ▼                         │ payments, sessions, events,
 Isolated Core public API (18090)       │ managed device registry
             │ MQTT                     │
             ▼                         │
 Charge-device simulator (18893) ───────┘
```

Core is external to Docker Compose. The API uses Core's public REST API with a
delegated user OAuth bearer token. The simulator is the only Charge Station
component that uses the Core MQTT device token.

## Ownership

| Component | Owns |
| --- | --- |
| Web | Browser UI, admin authentication state, QR checkout UI. It never receives Core secrets. |
| API | Order/payment orchestration, local persistence, server-derived Station/Device status, Core REST calls, authorization. |
| PostgreSQL | Business records and a local registry of Core device IDs. |
| Core | MQTT transport, telemetry history, command lifecycle and device authorization. |
| Simulator | Four relay demo states, electrical telemetry and manual relay timers. |

## Device and Station status

Device status is read-only. It is never toggled by an admin action.

| Device status | Server condition |
| --- | --- |
| `IN_USE` | A linked charging session is `STARTING`, `CHARGING`, or `STOPPING`. |
| `AVAILABLE` | The device has fresh Core telemetry and has no in-use charging session. |
| `OFFLINE` | No usable fresh Core telemetry is available. |

Station status is server-derived and is independent of relay demo buttons.

| Station status | Server condition |
| --- | --- |
| `IN_USE` | The linked device has an in-use charging session. |
| `AVAILABLE` | Core telemetry is fresh and the station has at least one `AVAILABLE` connector. |
| `UNAVAILABLE` | There is no usable device telemetry, no available connector, or no linked device. |

The customer QR scan endpoint returns connector `OFFLINE` when live device
telemetry is unavailable. This prevents the checkout UI from presenting an
unsafe connector as selectable. Order creation performs the same Core
telemetry freshness preflight before opening a payment reservation.

`managed_devices` is a local registry keyed by Core `device_id`; it allows the
admin Device list to retain known device IDs. It is not an admin-controlled
availability flag. Migrations `011` through `013` preserve data from the
earlier development iterations; new runtime behavior does not expose manual
Device occupy/release endpoints.

## Telemetry

The API requests Core telemetry for a fixed trailing 15-minute window. Core
returns pages ordered by its opaque `next_cursor`; continuation uses the `after`
query parameter. The client follows at most 20 pages and selects the record
with the highest `(event_at, sequence)` pair. A telemetry sample is stale after
`IOT_CORE_TELEMETRY_STALE_MS` (90 seconds by default, capped at 15 minutes).

The telemetry monitor emits charging-session events only for fresh telemetry
whose `session_id` matches the persisted session. Relay timer expiry remains a
simulator event; the browser and API do not own relay timing.

## Payment and charging lifecycle

1. Customer opens opaque `/scan/station/<token>` URL.
2. API verifies the QR token, Station safety state, connector availability and
   charging duration.
3. API atomically reserves the connector, persists an Order and a pending
   PaymentTransaction, then creates a PayOS mock/live payment link outside the
   database transaction.
4. A verified payment webhook creates a charging session and a persisted Core
   start command.
5. Core publishes the command to MQTT; the simulator responds with the actual
   relay state; API records the resulting session event.
6. Fresh matching telemetry drives heartbeats and final timer-expiry stop
   events. Connector release happens only through the persisted lifecycle.

`PAYOS_MODE=mock` is the supported local default. It does not call PayOS.

## Admin API

All `/admin/*` routes require a Charge Station admin JWT. Core OAuth and MQTT
tokens are never returned by these APIs.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/auth/login` | Admin JWT login. |
| `GET` | `/admin/overview` | Operations summary. |
| `GET`, `POST` | `/admin/stations` | List or create a Station. |
| `PUT` | `/admin/stations/:id/device` | Link or change a Core device ID. |
| `GET` | `/admin/stations/:id/qr` | Render the opaque station QR URL. |
| `POST` | `/admin/stations/:id/qr/rotate` | Invalidate older QR tokens. |
| `GET` | `/admin/devices` | Read-only Device status, telemetry and linked Station. |
| `GET` | `/admin/devices/:deviceId` | Device detail. |
| `POST` | `/admin/devices/:deviceId/relays/:relayId` | Technical relay demo only; ON defaults to 15 minutes. |
| `GET` | `/admin/sessions`, `/admin/payments` | Operational history. |
| `GET` | `/admin/device-timeline` | Command and Device event timeline. |

There are intentionally no Device `occupy`, `release`, or `hold` endpoints.

## Public API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/public/stations/scan/:token` | Resolve opaque QR and safe connector choices. |
| `POST` | `/orders` | Create a payment reservation and payment link. |
| `GET` | `/orders/:id`, `/orders/:id/payment-link` | Read order/payment state using its capability token. |
| `GET`, `POST` | `/sessions/:id`, `/sessions/:id/stop`, `/sessions/:id/retry-start` | Read/control an authorized charging session. |
| `POST` | `/payments/payos/webhook` | Signed payment state transition. |

## Local installation and start

Prerequisites: Docker Desktop/Compose v2, Node 22, pnpm 9, and an isolated
Core listening on public `127.0.0.1:18090`, management `:18091`, MQTT `:18893`.

1. Start and verify Core from `iot-core/` according to `iot-core/README.md`.
2. Supply runtime-only Core credentials; never put them in Git or `.env`.
3. Run the E2E harness:

```sh
export IOT_CORE_ACCESS_TOKEN='<delegated user token>'
export CORE_TENANT_PASSWORD='<tenant account password>'
export CORE_USER_PASSWORD='<Core user password>'
pnpm tsx scripts/core-iot-local-e2e.ts
```

The harness provisions/reuses a Core device, keeps the device MQTT token in a
private temporary directory, starts an isolated Compose project, and validates
the real flow. See [local-development.md](local-development.md) for ports,
environment values and the manual Compose procedure.

Stop only the Charge Station preview stack without deleting database data:

```sh
docker compose -p charge-station-preview down
```

Do not add `-v` unless deleting local PostgreSQL data is intended. Core has its
own lifecycle and must be stopped separately from `iot-core/`.

## Verification

```sh
pnpm --filter @charge-station/api test
pnpm --filter @charge-station/web test
pnpm --filter @charge-station/contracts test
pnpm --filter @charge-station/api test:postgres
PYTHONPATH=apps/core-iot-device-simulator python3 -m unittest discover -s apps/core-iot-device-simulator/tests -v
pnpm build
```

The PostgreSQL integration suite requires a running local PostgreSQL service.

## Known limits / incomplete work

- Core OAuth access tokens expire. The local workflow currently refreshes the
  delegated token manually; no production token-refresh service exists.
- Relay controls are a local technical demo. They are not a substitute for the
  charging payment/session lifecycle.
- Core runtime state and credentials are local-only operational assets, not
  source-controlled application data.
- Production PayOS configuration, external HTTPS callbacks and live Core
  credential issuance require environment-specific operational setup.
