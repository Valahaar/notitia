# Notitia

Notitia is a distributed HTTP scheduling microservice with a Python SDK. Schedule immediate, one-time, or recurring HTTP calls through a simple REST API or a typed Python client.

## Features

- **Flexible scheduling** — immediate execution, one-time (ISO 8601), or recurring (CRON / RRULE)
- **Pluggable backends** — GCP Cloud Tasks for production, in-memory scheduler for development
- **Long-term scheduling** — automatically handles jobs beyond GCP's 30-day limit via meta-jobs
- **Python SDK** with three abstraction levels:
  - `LowLevelClient` — direct HTTP calls with full control
  - `NotitiaClient` — typed, event-based client with pre-defined event definitions
  - `EventsBus` — domain-driven event system with handlers, scheduling, and state tracking
- **Framework integrations** — FastAPI webhook router, Beanie (MongoDB) state tracker

## Quick Start

```python
import asyncio
from notitia import LowLevelClient, NotitiaClientConfig, ScheduleRequest, OneTimeSchedule

async def main():
    client = LowLevelClient(NotitiaClientConfig(base_url="http://localhost:60000"))

    job_id = await client.send_schedule_request(ScheduleRequest(
        target="https://example.com/webhook",
        payload={"message": "Hello from Notitia!"},
        schedule=OneTimeSchedule(time="2025-12-25T10:00:00Z"),
    ))

    print(f"Scheduled job: {job_id}")
    await client.close()

asyncio.run(main())
```

## Project Structure

| Package | Description |
|---------|-------------|
| [`packages/service`](packages/service/) | NestJS HTTP scheduling microservice |
| [`packages/python-sdk`](packages/python-sdk/) | Python client library (`pip install notitia`) |

## Documentation

- **[Service documentation](packages/service/README.md)** — API reference, deployment, configuration
- **[SDK documentation](packages/python-sdk/README.md)** — Installation, usage guides, client APIs
- **[EventsBus guide](packages/python-sdk/docs/events-bus.md)** — Domain-driven event system
- **[Contrib integrations](packages/python-sdk/docs/contrib.md)** — FastAPI and Beanie adapters
- **[Examples walkthrough](docs/examples.md)** — Annotated guide through the example code

## Development

### Service (in-memory mode)

```bash
cd packages/service
npm install
SCHEDULER_TYPE=in-memory PORT=60000 npm run start:dev
```

### Service (Docker)

```bash
# In-memory mode for local development
docker compose up service-in-memory

# GCP mode (requires GCP credentials and Redis)
docker compose up service
```

### SDK

```bash
cd packages/python-sdk
pip install -e ".[all]"
```

## License

[Apache License 2.0](LICENSE)
