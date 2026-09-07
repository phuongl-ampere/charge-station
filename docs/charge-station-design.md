# Charge Station Platform Design

## Goals

Build an MVP for QR-based EV charging payments:

- A customer scans a connector QR code, chooses a duration, and pays with PayOS.
- Power is enabled only after a verified PayOS webhook callback.
- The IoT device owns the timer and automatically switches off its relay when time expires.
- The frontend receives real-time payment and charging status updates.

The MVP price is 5,000 VND per hour. The backend always calculates the price and total amount.

## Scope and Services

The system consists of two independent services.

| Service | Technology | Responsibilities |
| --- | --- | --- |
| `charge-station` | Next.js frontend, NestJS backend, TypeORM, PostgreSQL | Web checkout, JWT authentication, station and connector management, orders, PayOS payments, charging sessions, realtime updates, and command orchestration. |
| `iot-service` | Separate service; HTTP API mock for the MVP | Device connectivity, command delivery, acknowledgements and device events, and device status monitoring. Production can use MQTT, TCP/UDP, or a SIM-based protocol. |

`charge-station` never communicates directly with a relay or SIM protocol. It communicates only through the `iot-service` API.

## Logical Architecture

```text
Customer browser
  -> Next.js frontend
  -> NestJS Charge Station API
       -> PostgreSQL
       -> PayOS API / PayOS webhook
       -> IoT Service API (mock in MVP)
              -> Device / relay
```

NestJS uses Socket.IO to publish updates to the frontend. The IoT Service is internal and is not exposed to the frontend: Charge Station sends commands to IoT Service, and IoT Service calls the internal Charge Station event endpoint to report acknowledgements and device state.

## Timer Ownership

The IoT device is the source of truth for relay state and timing:

1. After payment, Charge Station sends `START_CHARGING` with `durationSeconds`.
2. IoT Service forwards the configuration to the device.
3. The device turns on the relay, counts down locally, and turns the relay off when time expires.
4. The device sends a `STOPPED` event to IoT Service, which forwards it to Charge Station.

The backend persists `startedAt` and `expectedEndAt` for UI display, monitoring connectivity, and reconciliation. This is an estimated UI value, not the safety mechanism that switches the relay off.

## Payment and Charging Flow

1. The QR code contains `stationCode` and `connectorCode`. The frontend fetches connector availability and pricing.
2. The frontend submits `connectorCode` and `durationMinutes` to create an order. The backend verifies availability and calculates the amount.
3. The backend creates an `Order` with `PENDING_PAYMENT`, creates a PayOS payment link, and returns its `checkoutUrl`.
4. The customer pays. PayOS sends a webhook to Charge Station.
5. The backend verifies the signature, amount, and `orderCode`, processes the callback idempotently, and updates the order to `PAID`.
6. The backend creates a `ChargingSession` in `PENDING`, records a `DeviceCommand`, and moves the session to `STARTING`.
7. The backend calls IoT Service at `POST /internal/commands/start`.
8. IoT Service returns an acknowledgement after the device accepts the configuration. Once the device confirms that the relay is on, IoT Service sends a `RUNNING` event.
9. Charge Station updates the session to `CHARGING` and publishes the update to the frontend through Socket.IO.
10. When the timer expires or the device receives a stop command, it sends `STOPPED`. The backend marks the session as `COMPLETED` or `CANCELLED`.

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

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/public/connectors/:connectorCode` | Get connector availability, pricing, and permitted durations. |
| `POST` | `/orders` | Create an order and payment request. Require JWT if the system requires sign-in. |
| `GET` | `/orders/:id` | Get order and payment status. |
| `GET` | `/sessions/:id` | Get charging status and estimated remaining time. |
| `POST` | `/sessions/:id/stop` | Request early charging stop. |
| `POST` | `/payments/payos/webhook` | PayOS-only server-to-server webhook endpoint. |

Create-order request:

```json
{
  "connectorCode": "ST01-C01",
  "durationMinutes": 120
}
```

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

## IoT Service Mock Contract

For the MVP, `iot-service` exposes internal REST APIs. Charge Station calls these APIs using a service token in development and mTLS or equivalent service authentication in production.

### Start Charging Command

`POST /internal/commands/start`

```json
{
  "commandId": "cmd_01J...",
  "sessionId": "ses_01J...",
  "stationCode": "ST01",
  "connectorCode": "ST01-C01",
  "durationSeconds": 7200,
  "expiresAt": "2026-09-08T12:00:00Z",
  "configVersion": 1
}
```

Acknowledgement response:

```json
{
  "commandId": "cmd_01J...",
  "accepted": true,
  "deviceId": "dev_ST01",
  "status": "ACCEPTED"
}
```

### Stop Charging Command

`POST /internal/commands/stop`

```json
{
  "commandId": "cmd_01J...",
  "sessionId": "ses_01J...",
  "reason": "USER_REQUESTED"
}
```

### Event from IoT Service to Charge Station

`POST /internal/device-events`

```json
{
  "eventId": "evt_01J...",
  "commandId": "cmd_01J...",
  "sessionId": "ses_01J...",
  "deviceId": "dev_ST01",
  "connectorCode": "ST01-C01",
  "type": "RUNNING",
  "occurredAt": "2026-09-08T10:01:20Z",
  "payload": {
    "remainingSeconds": 7200,
    "relayState": "ON"
  }
}
```

Supported event types: `COMMAND_ACCEPTED`, `RUNNING`, `HEARTBEAT`, `STOPPED`, `COMMAND_FAILED`, and `DEVICE_OFFLINE`.

The mock IoT Service must simulate:

- Command acknowledgement.
- A configurable delay before `RUNNING`.
- Decreasing `remainingSeconds`.
- Automatic `STOPPED` when the timer expires.
- Timeouts, offline devices, and command failures.

When the REST mock is replaced by MQTT or a SIM-based protocol, only `IoTServiceClient` in Charge Station should change. The command and event contracts remain stable.

## PostgreSQL Data Model

| Entity | Core data |
| --- | --- |
| `users` | Accounts, roles, and JWT identity. |
| `stations` | Charging stations and device mappings. |
| `connectors` | Connectors, availability, and applicable pricing. |
| `pricing_plans` | Pricing rules and time unit. |
| `orders` | Amount, payment state, and unique numeric PayOS order code. |
| `payment_transactions` | PayOS checkout URL, payment link ID, raw webhook payload, signature result, and idempotency key. |
| `charging_sessions` | Order and connector references, state, `startedAt`, `expectedEndAt`, and `stoppedAt`. |
| `device_commands` | Command ID, payload, retry count, acknowledgement/result, and timestamps. |
| `device_events` | Event ID, payload, event timestamp, and processing status. |

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
- Protect user APIs with JWT; use PayOS webhook signatures and service authentication between services.
- Devices must use `commandId` to prevent executing a relay command twice.
- The backend retries commands with a bounded retry policy; retries never change the session `durationSeconds`.
- If an acknowledgement does not arrive before its deadline, mark the session `START_FAILED` or `DEVICE_OFFLINE`, and notify the frontend and operations users.
- A `STOPPED` event is the final proof that the relay is off.

## MVP Scope

The MVP includes QR-to-payment, PayOS sandbox support, one 5,000 VND/hour pricing rule, Socket.IO, a mock IoT Service, one relay/connector per charging session, and a minimal status dashboard.

It excludes automated refunds, multiple pricing plans, reservations, offline payments, power sharing, firmware management, and the production MQTT protocol.
