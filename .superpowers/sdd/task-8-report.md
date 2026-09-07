# Task 8 Report: Local QR Checkout and Charging Status UI

## Outcome

Task 8 adds a Next.js operational charging interface in `apps/web`. It provides:

- `/scan/[connectorCode]` for local connector lookup, API-provided duration
  selection, exact order-total display, and payment-link creation.
- A local-only PayOS checkout panel with a QR code generated exclusively from
  the checkout URL and an accessible icon button that opens it in a new tab.
- `/charge/[orderId]` with a realtime charging instrument panel, including a
  thin vertical energy rail that reflects payment and charging state.
- `PENDING_PAYMENT`, `PAID`, `STARTING`, `CHARGING`, `COMPLETED`, and failure
  representations, plus device-owned remaining-time and warning readouts when
  a session projection is available.
- Socket.IO order/session subscriptions using the short-lived order token held
  only in `sessionStorage`, with a five-second local API polling fallback when
  the socket is disconnected.
- A stop action that is rendered only for a live session with that token and
  calls the existing protected local `POST /sessions/:id/stop` endpoint with a
  Bearer token.

## Local-Only Boundaries

- `apps/web/lib/api.ts` validates API and checkout URLs as loopback HTTP
  origins (`localhost`, `127.0.0.1`, or `[::1]`). A non-local URL is rejected
  before it can become a fetch target, QR payload, or checkout target.
- `apps/web/lib/socket.ts` connects only to the validated local API origin.
- Component tests use injected API/socket fakes. Playwright intercepts every
  local API checkout request at the browser-context level and uses
  `NEXT_PUBLIC_MOCK_SOCKET=1`, so it has no live API, Socket.IO, PayOS, remote
  image, or remote font dependency.

## TDD Evidence

1. Red: `DurationPicker.test.tsx` initially failed because
   `./DurationPicker` did not exist. The first implementation exposed an
   accessibility-name mismatch and duplicate price rendering; the control was
   refined to have exact duration button names and one station-total output.
   Green: the focused test passed after selecting two hours and asserting
   `10,000 VND`.
2. Red: `ChargingStatus.test.tsx` initially failed because
   `./ChargingStatus` did not exist. Green: with a disconnected injected socket
   and local fake API, advancing five seconds called `getOrder("ord_1")`.
3. Red: the initial Playwright run could not serve an app before the route tree
   existed. The first completed browser run identified the popup mock scope;
   the mock was moved from the page to the browser context so the checkout tab
   is also local and intercepted. Green: the complete desktop and mobile
   workflow passes.

## Verification

Fresh commands after formatting:

- `pnpm --filter @charge-station/web test`
  - Passed: 2 test files, 2 component tests.
- `pnpm --filter @charge-station/web lint`
  - Passed: strict TypeScript `tsc --noEmit`.
- `pnpm --filter @charge-station/web build`
  - Passed: Next.js production build generated `/`, `/scan/[connectorCode]`,
    and `/charge/[orderId]`.
- `pnpm --filter @charge-station/web playwright test`
  - Passed: 2 tests, desktop and Pixel 5 projects.
  - The browser flow selects two hours, opens the local mock PayOS checkout,
    and renders the waiting-for-payment status.
- `pnpm exec prettier --write apps/web package.json pnpm-lock.yaml`
  - Completed before the final verification commands.

## Browser Evidence

Playwright captured clean production-mode screenshots for both breakpoints:

- Desktop checkout and final status:
  `apps/web/test-results/checkout-selects-a-duratio-8845d-t-and-shows-payment-waiting-desktop/`
- Mobile checkout and final status:
  `apps/web/test-results/checkout-selects-a-duratio-8845d-t-and-shows-payment-waiting-mobile/`

The reviewed screenshots show the duration choices, QR/check-out controls,
station total, and status rail without text or control overlap. Mobile uses a
single-column duration selector and stacked checkout controls; desktop keeps a
compact three-column time selector and inline QR/action layout.

## Task 8 Review Remediation

- `GET /orders/:id` now includes `sessionId` when the persisted order has a
  charging session. This lets the status page discover and fetch the session
  after payment.
- `payment.updated` now publishes an object containing `orderId` and `status`;
  the successful paid transition also contains `sessionId`.
- `ChargingStatus` does not construct a local Socket.IO client until the
  short-lived order token has hydrated. A token change replaces the local
  client, subscribes it to the order and session after connect/reconnect, and
  disconnects only the client instance that its effect created.
- The delayed-token component regression covers paid-order session discovery,
  session fetching, order/session subscriptions, `CHARGING` and `COMPLETED`
  socket events, and a stop request that carries the hydrated token.

## Review Verification

- Focused red/green:
  - API projection and payment payload tests failed before the implementation
    because `sessionId` and structured event payloads were absent, then passed.
  - The delayed-token web regression failed before the implementation because
    `createChargeSocket()` ran without a token, then passed.
- `pnpm --filter @charge-station/api test`
  - Passed: 14 files, 55 tests.
- `pnpm --filter @charge-station/api test:e2e`
  - Passed: 4 files, 13 tests.
- `pnpm --filter @charge-station/api lint`
  - Passed.
- `pnpm --filter @charge-station/api build`
  - Passed.
- `pnpm --filter @charge-station/web test`
  - Passed: 2 files, 4 tests.
- `pnpm --filter @charge-station/web lint`
  - Passed.
- `pnpm --filter @charge-station/web build`
  - Passed.
- `pnpm --filter @charge-station/web playwright test`
  - Passed: desktop and Pixel 5 projects. All mocked API and checkout URLs are
    `localhost`; no external network endpoint is used.
- Inspected screenshots:
  - `apps/web/test-results/checkout-selects-a-duratio-8845d-t-and-shows-payment-waiting-desktop/`
  - `apps/web/test-results/checkout-selects-a-duratio-8845d-t-and-shows-payment-waiting-mobile/`
