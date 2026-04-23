---
description: GCP Cloud Tasks scheduler — meta-job indirection for 30-day limit, Redis UFID mapping, relay/meta endpoints
---

# Subsystem: GCP Scheduling

## Purpose

Production job scheduler that uses Google Cloud Tasks to execute HTTP requests at scheduled times. Handles GCP's 30-day maximum scheduling horizon via a meta-job re-scheduling pattern.

## Core Abstractions

- **`GcpTaskSchedulerService`** (`src/modules/gcp-scheduling/gcp-task.scheduler.service.ts`) — Implements `IJobScheduler`. Decides between direct relay tasks and meta-job indirection based on schedule horizon.
- **`GcpTaskRelayService`** (`src/modules/gcp-scheduling/gcp-task-relay.service.ts`) — Handles incoming `/relay` callbacks from GCP. Extracts original request from task payload, delegates to `HttpExecutorService`.
- **`MetaService`** (`src/modules/gcp-scheduling/meta.service.ts`) — Handles `/meta/:ufid` callbacks. Recomputes next execution time, creates the actual relay task or another meta-task.
- **`GcpTaskRelayController`** (`src/modules/gcp-scheduling/gcp-task-relay.controller.ts`) — Exposes `POST /relay`.
- **`MetaController`** (`src/modules/gcp-scheduling/meta.controller.ts`) — Exposes `POST /meta/:ufid`.
- **DTOs**: `GcpTaskRelayPayloadDto` and `GcpMetaTaskPayloadDto` (`src/modules/gcp-scheduling/dto/`).

## Invariants

- A job scheduled within 30 days of now goes directly as a **relay task** (GCP task → `/relay` → `HttpExecutorService`).
- A job beyond 30 days goes as a **meta-task** (GCP task → `/meta/:ufid` → recompute → create relay or another meta).
- Every meta-job has a **UFID** (User-Friendly ID, a UUID) stored in Redis mapping to the current GCP Task ID. This allows cancellation of the current GCP task by UFID lookup.
- Recurring jobs: after each execution, the scheduler computes the next occurrence and creates a new task (relay or meta depending on horizon).
- `GCP_MAX_SCHEDULE_SECONDS = 2,592,000` (30 days) is the hard ceiling from GCP Cloud Tasks.

## External Dependencies

- **`@google-cloud/tasks`** — GCP Cloud Tasks client for creating and deleting tasks.
- **`ioredis` / `@keyv/redis` / `cache-manager`** — Redis client for UFID → GCP Task ID persistence.
- **`ScheduleHelperService`** (`src/common/services/schedule.helper.service.ts`) — Parses CRON (`cron-parser`) and RRule (`rrule`) strings, computes next execution times.
- **`HttpExecutorService`** (`src/common/services/http-executor.service.ts`) — Executes the actual HTTP call to the target URL.

## Integration Points

- `JobSchedulingService` injects `IJobScheduler` via `JOB_SCHEDULER_TOKEN`; when `SCHEDULER_TYPE` is not `in-memory`, the GCP module is loaded.
- GCP tasks call back to the service itself at `NOTIFICATION_SERVICE_URL` + `/relay` or `/meta/:ufid`.
- The service injects its own `AUTH_TOKEN` into GCP task headers so callbacks pass auth.

## Known Pitfalls

- **30-day horizon**: Direct relay tasks fail if scheduled beyond `GCP_MAX_SCHEDULE_SECONDS`. The meta-job indirection handles this but adds complexity.
- **Redis TTL**: UFID mappings have no explicit TTL. They're deleted on cancellation or completion but can leak if the process crashes mid-operation.
- **Token rotation**: Pending GCP tasks carry the old `AUTH_TOKEN` in their headers. Rotating the token invalidates all in-flight tasks.
- **No idempotency tokens**: Relay and meta endpoints don't deduplicate; they rely on GCP's task-level dedup configuration.
- **Task ID format assumption**: `createTask()` returns the GCP task name and extracts the last path segment as ID — assumes GCP's naming format doesn't change.
- **Self-referencing URL**: `NOTIFICATION_SERVICE_URL` must be reachable from GCP Cloud Tasks (public or VPC-connected).
- **Dispatch deadline**: Cloud Tasks caps each attempt at 10 min by default (max 30 min). `ScheduleRequestDto.timeout` (seconds) sets the relay task's `dispatchDeadline` per-request; `DEFAULT_TIMEOUT_SECONDS` env var provides a service-wide default. Meta-task callbacks keep the 10 min default — they only recompute + reschedule, so they should return quickly. Any single HTTP target call that can exceed 30 min requires an async fire-and-forget pattern (return 202 quickly, complete the work out of band).

## Related Files

| File | Role |
|------|------|
| `src/modules/gcp-scheduling/gcp-scheduling.module.ts` | Module registration, Redis cache config |
| `src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` | Core scheduling logic, meta-job creation |
| `src/modules/gcp-scheduling/gcp-task-relay.service.ts` | Relay callback handler |
| `src/modules/gcp-scheduling/meta.service.ts` | Meta-task callback handler |
| `src/modules/gcp-scheduling/gcp-task-relay.controller.ts` | `/relay` endpoint |
| `src/modules/gcp-scheduling/meta.controller.ts` | `/meta/:ufid` endpoint |
| `src/modules/gcp-scheduling/dto/` | Payload DTOs for relay and meta tasks |
| `src/common/services/schedule.helper.service.ts` | CRON/RRule parsing |
