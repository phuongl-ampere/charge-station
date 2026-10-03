# Charge Station MVP

Local EV charging checkout with a mock PayOS payment flow and direct IoT Nano
integration. The Nano-connected simulator, not the browser or API
timer, owns relay start and stop.

Current architecture, status rules, API inventory, setup and known limits are
documented in [docs/architecture.md](docs/architecture.md).

## Run locally

Start IoT Nano at `http://127.0.0.1:18081`, then provision the dedicated
`tenant-cs` demo tenant. The seed writes the tenant PAT and device token to an
ignored, owner-only file for Compose:

```sh
IOT_NANO_SYSTEM_USERNAME='<system username>' \
IOT_NANO_SYSTEM_PASSWORD='<system password>' \
IOT_NANO_TENANT_PASSWORD='<tenant-cs password>' \
IOT_NANO_CS_ADMIN_PASSWORD='<cs-admin password>' \
IOT_NANO_CS_OPERATOR_PASSWORD='<cs-operator password>' \
pnpm seed:iot-nano
docker compose --env-file .charge-station-iot-nano.env up -d --build --wait
```

The seed requires system credentials only to create the isolated tenant. Do not
commit any resulting token, password, or `.charge-station-iot-nano.env` file.

Open `http://127.0.0.1:3100/admin`, create or select a station, then open its
opaque Station QR URL. The local mock checkout is served by the API and
requires no PayOS account or external request.

The operations console is at `http://127.0.0.1:3100/admin`. Compose seeds the
configured local admin account:

```text
Email: admin@charge.local
Password: local-admin-password-change-me
```

Change `ADMIN_EMAIL` and `ADMIN_PASSWORD` before exposing any environment
outside local development.

From **Stations**, an administrator can add a station and initial connector,
then render its opaque QR. Customer station URLs have the form
`/scan/station/<opaque-token>` and do not reveal station or connector codes.
Set a unique `STATION_QR_ENCRYPTION_KEY` for every non-local environment.

| Service            | Manual Compose URL                                                    |
| ------------------ | --------------------------------------------------------------------- |
| Web                | `http://localhost:3100`                                               |
| Charge Station API | `http://localhost:4000`                                               |
| API health         | `http://localhost:4000/health`                                        |
| IoT Nano           | API: `host.docker.internal:18081`; MQTT: `host.docker.internal:18883` |
| PostgreSQL         | `postgres://charge:charge@localhost:5432/charge_station`              |

Stop services with `docker compose down`.

See [local development](docs/local-development.md) for safe IoT Nano credential
setup, direct command/telemetry flow verification, signed mock webhook testing,
PayOS payment-link recovery, and sandbox or production callback requirements.
