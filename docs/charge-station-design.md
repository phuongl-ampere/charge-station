# Charge Station Platform Design

## Goals

Build an MVP for QR-based EV charging payments:

- A customer scans a connector QR code, chooses a duration, and pays with PayOS.
- Power is enabled only after a verified PayOS webhook callback.
- The IoT device owns the timer and automatically switches off its relay when time expires.
- The frontend receives real-time payment and charging status updates.

The MVP price is 5,000 VND per hour. The backend always calculates the price and total amount.

## Scope and Services

The system consists of the Charge Station application and an isolated Core IoT
deployment.

| Service                     | Technology                                            | Responsibilities                                                                                                                             |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `charge-station`            | Next.js frontend, NestJS backend, TypeORM, PostgreSQL | Web checkout, station and connector management, orders, PayOS payments, charging sessions, realtime updates, and Core command orchestration. |
| Core IoT                    | Isolated Core public API, management API, and MQTT    | Authenticated two-way commands, relay device connectivity, and telemetry retention.                                                          |
| `core-iot-device-simulator` | Python MQTT sidecar                                   | Isolated local relay simulation and periodic telemetry publication.                                                                          |

`charge-station` communicates with Core's public REST API; it never implements
the relay protocol itself.

## Logical Architecture

```text
Customer browser
  -> Next.js frontend
  -> NestJS Charge Station API
       -> PostgreSQL
       -> PayOS API / PayOS webhook
       -> Core public REST API
              -> Core MQTT broker
                    -> Device / relay simulator
```

NestJS uses Socket.IO to publish updates to the frontend. Charge Station marks
commands accepted only after Core's two-way command response confirms the relay
state, then uses Core telemetry for live measurements and operational state.

## Local Runtime

Docker Compose runs PostgreSQL, Charge Station API, the Core MQTT simulator, and
the Next.js web app locally. Core itself is deliberately external and isolated.
The API waits for PostgreSQL, runs migrations and the idempotent `ST01-C01`
demo seed, then becomes healthy at `GET /health`.

Browser-facing URLs use `localhost`: web at `http://localhost:3100` and API at
`http://localhost:4000`. Compose reaches the isolated Core through
`host.docker.internal:18090` for REST and `host.docker.internal:18893` for
MQTT. Local Compose defaults to `PAYOS_MODE=mock`, so payment-link creation and
checkout make no external PayOS calls.

## Timer Ownership

The IoT device is the source of truth for relay state and timing:

1. After payment, Charge Station sends `START_CHARGING` with `durationSeconds`.
2. Core delivers the configuration to the device over MQTT.
3. The device turns on the relay, counts down locally, and turns the relay off when time expires.
4. The device publishes telemetry, which Core retains for Charge Station to monitor.

The backend persists `startedAt` and `expectedEndAt` for UI display, monitoring connectivity, and reconciliation. This is an estimated UI value, not the safety mechanism that switches the relay off.

## Payment and Charging Flow

1. The physical station QR contains an AES-256-GCM encrypted station token, not a station or connector code. The frontend resolves the token, displays selectable connectors for that station, and fetches availability and pricing.
2. The frontend submits the selected `connectorCode` and `durationMinutes` to create an order. The backend verifies availability and calculates the amount.
3. The backend creates an `Order` with `PENDING_PAYMENT`, creates a PayOS payment link, and returns its `checkoutUrl`.
4. The customer pays. PayOS sends a webhook to Charge Station.
5. The backend verifies the signature, amount, and `orderCode`, processes the callback idempotently, and updates the order to `PAID`.
6. The backend creates a `ChargingSession` in `PENDING`, records a `DeviceCommand`, and moves the session to `STARTING`.
7. The backend submits a two-way `setRelay` command through Core's public API.
8. Core returns a device response after the relay accepts the configuration.
9. Charge Station updates the session to `CHARGING` and publishes the update to the frontend through Socket.IO.
10. When the timer expires or the device receives a stop command, Core telemetry
    confirms the relay state. The backend marks the session as `COMPLETED` or
    `CANCELLED`.

The browser redirect after payment is only for display. It must never activate charging.

## Business States

### Order

```text
PENDING_PAYMENT -> PAID
PENDING_PAYMENT -> PAYMENT_FAILED
PENDING_PAYMENT -> EXPIRED
PAID -> REFUNDED
```

### Charging Session

```text
PENDING -> STARTING -> CHARGING -> COMPLETED
                    -> START_FAILED
CHARGING -> STOPPING -> CANCELLED
CHARGING -> DEVICE_OFFLINE
```

`DEVICE_OFFLINE` is an operational warning state. Only a `STOPPED` event from the device confirms that the relay is off.

## Charge Station API

### Public and Authenticated APIs

| Method | Path                                | Purpose                                                                          |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------- |
| `GET`  | `/public/connectors/:connectorCode` | Get connector availability, pricing, and permitted durations.                    |
| `GET`  | `/public/stations/scan/:token`      | Resolve an encrypted station QR and return its selectable connectors.            |
| `POST` | `/orders`                           | Create an order and payment request. Require JWT if the system requires sign-in. |
| `GET`  | `/orders/:id`                       | Get order and payment status.                                                    |
| `GET`  | `/sessions/:id`                     | Get charging status and estimated remaining time.                                |
| `POST` | `/sessions/:id/stop`                | Request early charging stop.                                                     |
| `POST` | `/payments/payos/webhook`           | PayOS-only server-to-server webhook endpoint.                                    |

Create-order request:

```json
{
  "connectorCode": "ST01-C01",
  "durationMinutes": 120
}
```

## Admin Operations Console

The protected web console at `/admin` gives operations staff a live view of the
charging estate. It polls the Charge Station API every five seconds; this is a
display and operational-control channel, not the IoT relay timer authority.

| View            | Data shown                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Overview        | Station and connector totals, active sessions, paid PayOS revenue for the local day, pending payments, and operational alerts.    |
| Stations        | Connector availability, current session state, check-in, estimated device time remaining, device mapping, and stop/retry actions. |
| Sessions        | Current and historical sessions with order amount, booked duration, check-in, expected finish, check-out, and actual run time.    |
| Payments        | PayOS order code, payment/cancellation lifecycle, amount, connector, expiry, and update time.                                     |
| Device activity | Persisted command and event timeline, status, retry count, connector, and session correlation.                                    |

`ADMIN` and `OPERATOR` JWT roles can read the operations APIs and request stop
or retry-start actions. `CUSTOMER` tokens receive `403 Forbidden`. Stop and
retry requests reuse the existing command dispatcher and device event flow;
they never bypass Core IoT or alter the device-owned timer.

| Method | Path                               | Purpose                                                              |
| ------ | ---------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/admin/overview`                  | Operations totals and alerts.                                        |
| `GET`  | `/admin/stations`                  | Station/connector live state.                                        |
| `GET`  | `/admin/sessions?limit=50`         | Latest charging sessions and check-in/out ledger.                    |
| `GET`  | `/admin/payments?limit=50`         | Latest PayOS payment ledger.                                         |
| `GET`  | `/admin/device-timeline?limit=100` | Command and device-event audit timeline.                             |
| `POST` | `/admin/sessions/:id/stop`         | Request a normal IoT stop command.                                   |
| `POST` | `/admin/sessions/:id/retry-start`  | Retry a fresh recoverable failed start command.                      |
| `POST` | `/admin/stations`                  | Create a station from its code and optional device ID.               |
| `GET`  | `/admin/stations/:id/qr`           | Generate the encrypted station scan URL used to render a QR code.    |
| `POST` | `/admin/stations/:id/qr/rotate`    | Increment the QR version and invalidate all prior station QR tokens. |

For local Compose, the idempotent seed creates an `ADMIN` account only when
both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured. These values must be
set explicitly; production credentials must not use the local defaults.

Station creation and station-QR endpoints require the `ADMIN` role. Creating a
station uses the station code as its stored display name and provisions the
internal default charge point `<stationCode>-C01` required by the existing
payment and IoT model; neither field is entered by an administrator. A QR token
encrypts `{ stationId, qrVersion }` using AES-256-GCM with
`STATION_QR_ENCRYPTION_KEY`, a unique 64-character hexadecimal key. The token
is opaque, URL-safe, and does not expose station or connector codes. Rotating a
station QR increments `stations.qrVersion`, so any previously printed token
resolves as `404` without needing to persist individual QR tokens.

Response:

```json
{
  "orderId": "ord_01J...",
  "amount": 10000,
  "currency": "VND",
  "payment": {
    "provider": "PAYOS",
    "checkoutUrl": "https://pay.payos.vn/web/..."
  }
}
```

## PayOS Integration

Each pending order has one unique positive numeric `payosOrderCode`. Charge Station
creates a PayOS payment link with an ASCII-only description of at most 25 characters
and returns `checkoutUrl` to the frontend. The PayOS-hosted checkout page presents the
payment QR; the frontend can also render `checkoutUrl` as a convenience QR.

`POST /payments/payos/webhook` is the only authoritative payment confirmation path.
The backend verifies the HMAC-SHA256 signature over non-empty `data` fields sorted
alphabetically, checks the incoming `orderCode` and rounded amount against the order,
and completes the transaction idempotently. Browser return and cancel URLs are
informational and must only redirect the customer to the charge status page.

Required configuration:

```text
PAYOS_CLIENT_ID
PAYOS_API_KEY
PAYOS_CHECKSUM_KEY
PAYOS_RETURN_URL
PAYOS_CANCEL_URL
```

For production, configure the PayOS dashboard webhook URL as:

```text
https://<public-api-host>/payments/payos/webhook
```

Set `PAYOS_RETURN_URL` and `PAYOS_CANCEL_URL` to `https://<public-api-host>/payments/payos/return` and `https://<public-api-host>/payments/payos/cancel`. These public callback URLs cannot be `localhost`. Only the verified webhook activates charging; return and cancel are browser display redirects and cannot change payment or charging state.

## Direct Core IoT Contract

Charge Station uses Core's authenticated public API. A charging start creates a
two-way `setRelay` command at
`POST /api/v1/devices/{device_id}/commands`, with an idempotency key equal to
the persisted Charge Station command ID:

```json
{
  "method": "setRelay",
  "mode": "two_way",
  "params": {
    "relayId": "relay-1",
    "enabled": true,
    "durationSeconds": 7200,
    "sessionId": "ses_01J..."
  }
}
```

Charge Station polls `GET /api/v1/commands/{command_id}` for the two-way device
response and treats `responded` with `response.ok=true` and the requested relay
state as confirmation. A stop submits the same method with `enabled: false`.
It reads `GET /api/v1/telemetry/{device_id}` for `relay_state`,
`remaining_seconds`, and electrical measurements.

The simulator subscribes to Core MQTT RPC requests and responds to `setRelay`;
it periodically publishes the telemetry fields Core exposes. Its MQTT device
token is never committed or persisted by the application.

## PostgreSQL Data Model

| Entity                 | Core data                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `users`                | Accounts, roles, and JWT identity.                                                               |
| `stations`             | Charging stations, device mappings, and `qrVersion` used to invalidate rotated QR tokens.        |
| `connectors`           | Connectors, availability, and applicable pricing.                                                |
| `pricing_plans`        | Pricing rules and time unit.                                                                     |
| `orders`               | Amount, payment state, and unique numeric PayOS order code.                                      |
| `payment_transactions` | PayOS checkout URL, payment link ID, raw webhook payload, signature result, and idempotency key. |
| `charging_sessions`    | Order and connector references, state, `startedAt`, `expectedEndAt`, and `stoppedAt`.            |
| `device_commands`      | Command ID, payload, retry count, acknowledgement/result, and timestamps.                        |
| `device_events`        | Event ID, payload, event timestamp, and processing status.                                       |

`orders.payosOrderCode`, `payment_transactions.payosPaymentLinkId`,
`device_commands.commandId`, and `device_events.eventId` must be unique.

## Frontend Realtime Updates

The frontend connects to Socket.IO after creating an order and subscribes to:

- `order:{orderId}` for `payment.updated`.
- `session:{sessionId}` for `session.updated` and `device.updated`.

If Socket.IO disconnects, the frontend polls `GET /orders/:id` and `GET /sessions/:id` every 3-5 seconds. The UI shows "Charging" only after a `RUNNING` event. `PAID` and `STARTING` require a separate "starting charging" state.

## Security and Reliability

- Verify the PayOS webhook signature and amount before updating an order.
- Process PayOS webhook callbacks idempotently and retain the raw payload for reconciliation.
- Never trust `amount`, `price`, or payment results supplied by the frontend.
- Protect user APIs with JWT; use PayOS webhook signatures and Core bearer-token authorization for device commands and telemetry.
- Use `STATION_QR_ENCRYPTION_KEY` for station QR encryption. Do not expose station codes in physical QR URLs; rotate the QR version when a printed QR must be revoked.
- Devices must use `commandId` to prevent executing a relay command twice.
- The backend retries commands with a bounded retry policy; retries never change the session `durationSeconds`.
- If a Core two-way response does not arrive before its deadline, mark the session `START_FAILED` or `DEVICE_OFFLINE`, and notify the frontend and operations users.
- Core telemetry is the final proof that the relay is off.

## MVP Scope

The MVP includes QR-to-payment, PayOS sandbox support, one 5,000 VND/hour pricing rule, Socket.IO, direct Core IoT integration, one relay/connector per charging session, and a minimal status dashboard.

It excludes automated refunds, multiple pricing plans, reservations, offline payments, power sharing, and firmware management.
