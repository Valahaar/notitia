---
description: REST endpoints, DTO shapes, schedule types, auth token convention, and HTTP method/status patterns
---

# Convention: API Contract

## Intent

Ensure consistent communication between the Python SDK and the NestJS service, and between the service's internal relay/meta endpoints.

## Rule

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/schedule` | Bearer token | Schedule a new job (immediate, one-time, or recurring) |
| `DELETE` | `/schedule/:id` | Bearer token | Cancel a scheduled job by ID (query param `queue` required for GCP) |
| `POST` | `/relay` | Bearer token | Internal: GCP Cloud Tasks calls this to trigger actual HTTP execution |
| `POST` | `/meta/:ufid` | Bearer token | Internal: GCP meta-task callback to re-evaluate and re-schedule long-term jobs |

### Schedule Request DTO

```typescript
// src/common/dto/schedule-request.dto.ts
{
  target: string;          // URL to call when job fires
  method?: HttpMethod;     // GET, POST, PUT, DELETE, PATCH (default: POST)
  payload?: object;        // Request body
  headers?: Record<string, string>;
  params?: Record<string, string>;  // Query parameters
  queue?: string;          // GCP queue name override
  timeout?: number;        // Max seconds a single HTTP attempt may run (15–1800).
                           // Maps to Cloud Tasks dispatch deadline on GCP scheduler.
                           // Falls back to DEFAULT_TIMEOUT_SECONDS env var, else
                           // Cloud Tasks' 600s default.
  schedule?: {
    type: "ON",            // One-time
    time: string           // ISO 8601 datetime (UTC assumed)
  } | {
    type: "RECURRING",
    pattern: string        // CRON expression or "RRULE:..." string
  }
}
```

Omitting `schedule` means immediate execution.

### Response Conventions

- **202 Accepted** on successful scheduling, body contains `{ jobId: string }`.
- **200 OK** on successful cancellation, body contains `{ success: boolean }`.
- Error responses use NestJS default `HttpException` format via `HttpExceptionFilter` (`src/common/filters/http-exception.filter.ts`).

#### GCP scheduling failures preserve retryability

When the GCP scheduler's `createTask` call fails, `GcpTaskSchedulerService.createTask` maps the gRPC status code (`google.rpc.Code`) to the corresponding HTTP status via `GRPC_CODE_TO_HTTP_STATUS`, rather than collapsing everything to `400`. This keeps transient/server-side failures retryable end-to-end:

| gRPC code | HTTP | Retryable |
|-----------|------|-----------|
| INVALID_ARGUMENT (3), FAILED_PRECONDITION (9), OUT_OF_RANGE (11) | 400 | no |
| UNAUTHENTICATED (16) / PERMISSION_DENIED (7) / NOT_FOUND (5) | 401 / 403 / 404 | no |
| ALREADY_EXISTS (6) / ABORTED (10) | 409 | no |
| RESOURCE_EXHAUSTED (8) | 429 | yes |
| DEADLINE_EXCEEDED (4) / UNAVAILABLE (14) | 504 / 503 | yes |
| INTERNAL (13) / UNKNOWN (2) / DATA_LOSS (15) / unmapped | 500 | yes |

The Python SDK retries `429` and `5xx`, so mapping (not masking) is what lets a GCP rate-limit or transient blip during scheduling be retried automatically. All these failures are logged under `Error creating GCP task` with the full gRPC `statusDetails`/`fieldViolations`, the mapped `httpStatus`, and the task shape; the enrichment/logging is wrapped so it can never itself alter the response.

### Auth

The service uses a moat-and-castle trust model:

- **`/schedule`, `/schedule/:id`** — No auth. These endpoints are only reachable within the VPC. Internal services call them directly without a token to avoid spreading secrets.
- **`/relay`, `/meta/:ufid`** — Require `Authorization: Bearer <token>` matching the `AUTH_TOKEN` env var. These are reachable by GCP Cloud Tasks, which traverses outside the VPC boundary, so they need application-level auth. The service embeds `AUTH_TOKEN` into Cloud Tasks headers at creation time.

`AuthGuard` (`src/common/guards/auth.guard.ts`) uses `crypto.timingSafeEqual` for constant-time token comparison. `AUTH_TOKEN` is validated at startup — the service refuses to boot if it's missing.

### SDK-Side Serialization

The Python SDK (`low_level_client.py`) serializes `ScheduleRequest` dataclasses via `dataclasses.asdict()` with manual post-processing:
- Enum values (`.value`) substituted for enum instances
- `None` values stripped at both top-level and nested schedule level
- Default queue from `NotitiaConfig` applied if not specified per-request

## Rationale

The discriminated union on `schedule.type` allows a single endpoint to handle all scheduling modes. The 202 status signals that work is accepted but not yet completed — matching the async nature of scheduling.

## Exceptions

- In-memory scheduler ignores the `queue` field entirely.
- The `/relay` and `/meta` endpoints are not part of the public API — they exist solely for GCP Cloud Tasks callbacks.

## Enforcement

- `class-validator` and `class-transformer` decorators on DTOs enforce shape at the controller level.
- The Python SDK uses dataclass type hints but validation is primarily structural (no runtime schema enforcement beyond type checks).
