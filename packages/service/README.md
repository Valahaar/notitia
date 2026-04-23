# Notitia Service

NestJS-based HTTP scheduling microservice. Accepts scheduling requests via a REST API and executes HTTP calls at the specified time using pluggable scheduler backends.

## API Reference

### `POST /schedule`

Schedule an HTTP call for immediate, one-time, or recurring execution.

**Request body:**

```json
{
  "target": "https://example.com/webhook",
  "method": "POST",
  "payload": { "key": "value" },
  "headers": { "X-Custom": "header" },
  "params": { "foo": "bar" },
  "queue": "my-queue",
  "schedule": {
    "type": "on",
    "time": "2025-12-25T10:00:00Z"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string (URL) | Yes | URL to call |
| `method` | string | No | `POST` (default), `GET`, `PUT`, `DELETE`, `PATCH` |
| `payload` | object | No | JSON body for the HTTP request |
| `headers` | object | No | Custom HTTP headers |
| `params` | object | No | URL query parameters |
| `queue` | string | No | Queue identifier (defaults to the service's configured queue) |
| `schedule` | object | No | When to execute (omit for immediate) |
| `timeout` | integer | No | Max duration (seconds, 15–1800) a single HTTP attempt may run. Maps to the Cloud Tasks dispatch deadline on the GCP scheduler. Falls back to `DEFAULT_TIMEOUT_SECONDS`, else 600s (Cloud Tasks default). |

**Schedule types:**

```jsonc
// One-time: execute at a specific UTC time
{ "type": "on", "time": "2025-12-25T10:00:00Z" }

// Recurring (CRON): every day at midnight
{ "type": "recurring", "schedule": "0 0 * * *" }

// Recurring (RRULE): every weekday at 9am
{ "type": "recurring", "schedule": "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9" }

// Immediate: omit the schedule field entirely
```

**Response:** `202 Accepted`

```json
{ "jobId": "1234567890123456789" }
```

The `jobId` is a stable identifier you can use for cancellation. For recurring or long-term jobs, this is a UFID (User-Friendly ID) that persists across internal rescheduling.

### `DELETE /schedule/:id`

Cancel a scheduled job.

| Parameter | Location | Description |
|-----------|----------|-------------|
| `id` | Path | Job ID returned from `POST /schedule` |
| `queue` | Query | Optional queue name |

**Response:** `200 OK` with `true` (cancelled) or `false` (not found)

### `GET /health`

Health check endpoint. Returns `{ "status": "ok" }`.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | — | Bearer token for internal endpoint authentication |
| `SCHEDULER_TYPE` | No | `gcp` | Scheduler backend: `gcp` or `in-memory` |
| `PORT` | No | `3000` | Server port |
| `GCP_PROJECT_ID` | GCP mode | — | GCP project ID |
| `GCP_LOCATION_ID` | GCP mode | — | GCP location (e.g., `europe-west1`) |
| `GCP_JOB_QUEUE_NAME` | GCP mode | — | GCP Cloud Tasks queue name |
| `NOTIFICATION_SERVICE_URL` | GCP mode | — | Public base URL of this service (for GCP callbacks) |
| `REDIS_HOST` | GCP mode | `localhost` | Redis host (used for UFID mapping) |
| `REDIS_PORT` | GCP mode | `6379` | Redis port |
| `DEFAULT_TIMEOUT_SECONDS` | No | `600` | Default max duration (seconds, 15–1800) per HTTP attempt when the request body does not specify `timeout`. Maps to the Cloud Tasks dispatch deadline on the GCP scheduler. |
| `THROTTLE_TTL` | No | — | Rate-limit window in ms. Set together with `THROTTLE_LIMIT` to enable global throttling (opt-in). Omit both to disable. |
| `THROTTLE_LIMIT` | No | — | Max requests per `THROTTLE_TTL` window. Opt-in; see above. |

### Authentication

All public API endpoints (`/schedule`) and internal endpoints (`/relay`, `/meta`) require a `Authorization: Bearer <AUTH_TOKEN>` header. The service validates the token using timing-safe comparison.

## Deployment

### Docker

```bash
cd packages/service

# Build the image
npm run docker

# Push to registry
npm run docker:push
```

### Docker Compose

```bash
# In-memory mode (local development, no GCP/Redis needed)
docker compose up service-in-memory

# GCP mode (requires GCP credentials and Redis)
docker compose up service
```

### Local Development

```bash
cd packages/service
npm install

# In-memory mode (no external dependencies)
SCHEDULER_TYPE=in-memory AUTH_TOKEN=dev-token PORT=60000 npm run start:dev

# Swagger API docs available at http://localhost:60000/docs
```

## Architecture

### Scheduler Backends

The service uses a pluggable `IJobScheduler` interface with two implementations:

**GCP Cloud Tasks** (`SCHEDULER_TYPE=gcp`) — Production backend. Creates Cloud Tasks that call back into the service at the scheduled time. Requires Redis for job ID mapping.

**In-Memory** (`SCHEDULER_TYPE=in-memory`) — Development backend. Uses `setTimeout` for scheduling. Jobs are lost on restart. Includes retry logic (3 attempts, exponential backoff).

### Meta-Job System

GCP Cloud Tasks has a 30-day scheduling limit. For jobs scheduled further out or recurring jobs, Notitia uses a **meta-job** pattern:

1. A meta-job is created that re-checks and reschedules the actual job when it's closer to execution time
2. Each meta-job gets a **UFID** (User-Friendly ID) — a stable 19-digit numeric identifier
3. The UFID remains constant even as the underlying GCP task is recreated during rescheduling
4. Redis stores the `UFID -> GCP Task ID` mapping for cancellation

For recurring jobs, after each execution the meta-job automatically reschedules itself for the next occurrence.

### Internal Endpoints

These endpoints are used by GCP Cloud Tasks to call back into the service. They are not part of the public API.

- `POST /relay` — Receives a task from GCP and executes the HTTP call to the target URL. Adds an `X-Notitia-Task-ID` header to the outbound request.
- `POST /meta/:id` — Processes meta-job callbacks. Either reschedules the meta-job (if still too far out) or creates a direct relay task.

### Security

- **Helmet** — HTTP security headers
- **Rate limiting** — Opt-in; set `THROTTLE_TTL` (ms) and `THROTTLE_LIMIT` to enable global throttling. Disabled by default.
- **Input validation** — Strict whitelist validation on all request bodies
- **CRLF sanitization** — User-provided headers are sanitized to prevent header injection
- **Query parameter redaction** — Query params are redacted in logs to protect API keys
- **Request ID** — Every request gets an `X-Request-ID` header for tracing
