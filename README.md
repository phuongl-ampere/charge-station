# Charge Station MVP

Local EV charging checkout with a mock PayOS payment flow and direct isolated
Core IoT integration. The Core-connected simulator, not the browser or API
timer, owns relay start and stop.

## Run locally

```sh
docker compose up -d --wait
```

Open `http://localhost:3100/scan/ST01-C01`. The local mock checkout is served by the API and requires no PayOS account or external request.

The operations console is at `http://localhost:3100/admin`. Compose seeds the
configured local admin account:

```text
Email: admin@charge.local
Password: local-admin-password-change-me
```

Change `ADMIN_EMAIL` and `ADMIN_PASSWORD` before exposing any environment
outside local development.

From **Stations**, an administrator can add a station and initial connector,
then render its encrypted QR. Customer station URLs have the form
`/scan/station/<opaque-token>` and do not reveal station or connector codes.
Set a unique `STATION_QR_ENCRYPTION_KEY` for every non-local environment.

| Service            | Local URL                                                             |
| ------------------ | --------------------------------------------------------------------- |
| Web                | `http://localhost:3100`                                               |
| Charge Station API | `http://localhost:4000`                                               |
| API health         | `http://localhost:4000/health`                                        |
| Core IoT           | API: `host.docker.internal:18090`; MQTT: `host.docker.internal:18893` |
| PostgreSQL         | `postgres://charge:charge@localhost:5432/charge_station`              |

Stop services with `docker compose down`. To remove local database data as well, run `docker compose down -v`.

See [local development](docs/local-development.md) for safe Core credential
setup, direct command/telemetry flow verification, signed mock webhook testing,
PayOS payment-link recovery, and sandbox or production callback requirements.
