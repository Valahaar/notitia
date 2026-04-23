---
description: Monorepo structure — NestJS scheduling service + Python SDK client, packaging, and deployment topology
---

# Architecture: System Overview

## Scope

The entire Notitia monorepo: two packages under `packages/`, Docker infrastructure, and their relationship.

## Responsibilities

Notitia is a distributed notification and job scheduling system. It accepts HTTP scheduling requests (immediate, one-time delayed, or recurring) and executes them at the specified time by making HTTP calls to target URLs.

The monorepo contains:

- **`packages/service/`** — A NestJS (TypeScript) HTTP service that receives scheduling requests and dispatches them via a pluggable scheduler backend (GCP Cloud Tasks for production, in-memory for dev/test).
- **`packages/python-sdk/`** — An async Python client library (`notitia` on PyPI) that provides a typed, event-driven interface for emitting notifications to the service.

## Non-goals

- Notitia is not a message broker or event bus — it schedules HTTP calls, not pub/sub.
- The SDK does not implement retries or queue semantics; it delegates scheduling entirely to the service.

## Key Constraints

- **Pluggable scheduler**: The service uses `IJobScheduler` (`src/common/interfaces/job-scheduler.interface.ts`) with a `JOB_SCHEDULER_TOKEN` injection token. The active implementation is selected by the `SCHEDULER_TYPE` environment variable at startup (`src/app.module.ts`).
- **Two scheduler implementations**: `GcpTaskSchedulerService` (production) and `InMemorySchedulerService` (dev/test). They share no state.
- **Auth**: Moat-and-castle model. `/schedule` endpoints are unauthenticated (VPC-internal only). `/relay` and `/meta` require a Bearer token matching `AUTH_TOKEN` env var because GCP Cloud Tasks callbacks traverse outside the VPC. `AuthGuard` (`src/common/guards/auth.guard.ts`) uses timing-safe comparison. `AUTH_TOKEN` is validated at startup.

## System Interactions

```
Python SDK (httpx)
    → POST /schedule  or  DELETE /schedule/:id
        → NestJS Service (JobSchedulingController)
            → IJobScheduler implementation
                ├─ GCP Cloud Tasks → /relay or /meta/:ufid (self-callback)
                └─ In-memory setTimeout
            → HttpExecutorService → target URL
```

The service is deployed as a Docker container (`packages/service/Dockerfile`). `docker-compose.yml` at the root defines two service variants: `service` (GCP-backed with Redis) and `service-in-memory` (standalone dev mode).

Environment variables configure GCP project/queue, Redis connection, auth token, and the service's own URL for self-referencing callbacks.

## Security Hardening

- **Rate limiting**: `@nestjs/throttler` is **opt-in** — `ThrottlerModule` and `ThrottlerGuard` are only registered when both `THROTTLE_TTL` (ms) and `THROTTLE_LIMIT` env vars are set to positive numbers. When unset, no throttler runs and zero overhead is incurred.
- **Body size limit**: `express.json({ limit: '1mb' })`.
- **Security headers**: `helmet()` middleware.
- **Exception filters**: `HttpExceptionFilter` for structured HTTP errors, `AllExceptionsFilter` as catch-all to prevent stack trace leaks.
- **Request tracing**: `RequestIdMiddleware` generates/propagates `X-Request-ID` on every request.
- **Header sanitization**: User-supplied headers are stripped of CRLF sequences before outgoing requests.
- **Log sanitization**: `safeUrl()` strips query strings from URLs in all log output to prevent leaking API keys.
- **HTTP timeout**: Per-request via `timeout` field on `ScheduleRequestDto` (15–1800s). Falls back to `DEFAULT_TIMEOUT_SECONDS` env var, else 10 min (matches Cloud Tasks' default dispatch deadline). For GCP, the value is also set as the task's `dispatchDeadline` so Cloud Tasks and axios time out in lockstep.
- **Health check**: `GET /health` (throttle-exempt when throttling is enabled) for container probes.
- **In-memory retry**: Dev scheduler retries failed executions up to 3 times with exponential backoff.

## Failure Modes

- **GCP scheduler**: If Cloud Tasks fails or Redis is unavailable, job creation fails with an HTTP error propagated to the client.
- **In-memory scheduler**: All scheduled jobs are lost on process restart — no persistence.
- **Auth token rotation**: Pending GCP tasks carry the old token in their headers; rotating `AUTH_TOKEN` invalidates them.

## Related Knowledge

- [GCP Scheduling](../subsystems/gcp-scheduling.md) — production scheduler details
- [In-Memory Scheduling](../subsystems/in-memory-scheduling.md) — dev scheduler details
- [Python SDK](../subsystems/python-sdk.md) — client library
- [API Contract](../conventions/api-contract.md) — endpoints, DTOs, auth
