# Charge Station MVP

Local EV charging checkout with a mock PayOS payment flow and a separate mock IoT service. The device simulation, not the browser or API timer, owns relay start and stop.

## Run locally

```sh
docker compose up -d --wait
```

Open `http://localhost:3000/scan/ST01-C01`. The local mock checkout is served by the API and requires no PayOS account or external request.

| Service | Local URL |
| --- | --- |
| Web | `http://localhost:3000` |
| Charge Station API | `http://localhost:4000` |
| API health | `http://localhost:4000/health` |
| IoT health | Compose network only: `http://iot-service:4001/health` |
| PostgreSQL | `postgres://charge:charge@localhost:5432/charge_station` |

Stop services with `docker compose down`. To remove local database data as well, run `docker compose down -v`.

See [local development](docs/local-development.md) for environment variables,
signed mock webhook testing, mock failure modes, verification commands, and
PayOS sandbox or production callback requirements.
