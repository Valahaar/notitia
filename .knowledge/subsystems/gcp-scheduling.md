---
description: GCP Cloud Tasks scheduler — meta-job indirection for 30-day limit, UFID mapping (Keyv cache), relay/meta endpoints
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
- Every meta-job has a **UFID** (User-Friendly ID, a UUID) stored in the Keyv cache (Mongo in prod) mapping to the current GCP Task ID. This allows cancellation of the current GCP task by UFID lookup.
- `scheduleInternal` normalizes a recurring schedule once (anchors an RRULE without DTSTART, keeps `timezone`) and sends that anchored rule onward in every meta payload. Meta payloads carry `occurrence` (ISO-8601 UTC of the occurrence they serve; `isOccurrence` stays for old readers), and scheduled relays (direct one-offs with a time, recurring and long one-off final hops) send `X-Notitia-Occurrence`; immediate ones do not.
- Recurring jobs: after each execution, the scheduler computes the next occurrence and creates a new task (relay or meta depending on horizon).
- `GCP_MAX_SCHEDULE_SECONDS = 2,592,000` (30 days) is the hard ceiling from GCP Cloud Tasks.

## External Dependencies

- **`@google-cloud/tasks`** — GCP Cloud Tasks client for creating and deleting tasks.
- **`cache-manager` / Keyv** — UFID → GCP Task ID persistence (Mongo-backed in prod).
- **`ScheduleHelperService`** (`src/common/services/schedule.helper.service.ts`) — Parses CRON (`cron-parser`) and RRule (`rrule`) strings, computes next execution times.
- **`HttpExecutorService`** (`src/common/services/http-executor.service.ts`) — Executes the actual HTTP call to the target URL.

## Integration Points

- `JobSchedulingService` injects `IJobScheduler` via `JOB_SCHEDULER_TOKEN`; when `SCHEDULER_TYPE` is not `in-memory`, the GCP module is loaded.
- GCP tasks call back to the service itself at `NOTIFICATION_SERVICE_URL` + `/relay` or `/meta/:ufid`.
- The service injects its own `AUTH_TOKEN` into GCP task headers so callbacks pass auth.

## Known Pitfalls

- **30-day horizon**: Direct relay tasks fail if scheduled beyond `GCP_MAX_SCHEDULE_SECONDS`. The meta-job indirection handles this but adds complexity.
- **UFID cache TTL**: UFID mappings have no explicit TTL. They're deleted on cancellation or completion but can leak if the process crashes mid-operation.
- **Token rotation**: Pending GCP tasks carry the old `AUTH_TOKEN` in their headers. Rotating the token invalidates all in-flight tasks.
- **Every task is named**: `createTask` always sets `task.name`, so Cloud Tasks deduplicates by name. `ALREADY_EXISTS` (code 6) is treated as success and returns the given name (log `cloud-tasks-task-already-exists`). Names come from `taskNameFor(parts)` (`task-name.ts`: first 40 hex chars of SHA-256 over the NUL-joined parts). A direct relay task uses `taskNameFor(['key', queue, idempotencyKey])` when the caller sent `idempotencyKey`, so a retried `POST /schedule` returns the same job id; otherwise it gets a fresh `taskNameFor(['req', randomUUID()])`. Cloud Tasks refuses a name for about an hour after its task ran or was deleted, so reusing a key within that window silently yields "success" with no new task. The meta branch is still unkeyed here.
- **Task ID format assumption**: `createTask()` returns the GCP task name and extracts the last path segment as ID — assumes GCP's naming format doesn't change.
- **Transient bare `INVALID_ARGUMENT` from `createTask`**: Cloud Tasks sometimes rejects a valid request with `3 INVALID_ARGUMENT: Request contains an invalid argument.` and no `fieldViolations`/`statusDetails`; the identical request succeeds a moment later. `CloudTasksClientHolder.call()` retries only that bare form, up to 3 attempts with jittered exponential backoff (150ms base, no client rebuild), and `createTask()` answers **503** (callers' SDK retries 5xx) if it persists. `INVALID_ARGUMENT` that names a field still fails fast as 400.
- **Dead channels**: a long-idle gRPC channel can be silently dropped, so calls hang until their deadline. All Cloud Tasks calls go through `CloudTasksClientHolder` (`cloud-tasks-client.holder.ts`): keepalive options (`CLOUD_TASKS_KEEPALIVE_OPTIONS`), an 8 s per-attempt deadline, and on DEADLINE_EXCEEDED/UNAVAILABLE a single-flight client rebuild (old client `close()`d) plus retry with jittered backoff inside a 25 s total budget, after which the last error is rethrown (createTask then answers 504/503). `createTask` retries are safe because every task is named: a retry after a lost response answers `ALREADY_EXISTS`, which is treated as success. google-gax's `createStub` copies every constructor option starting with `grpc.` into the `@grpc/grpc-js` channel options, so the keepalive keys reach the channel as written. Cloud Run throttles CPU between requests, so keepalive pings only run during calls; Google front ends answer pings more often than they allow with GOAWAY `ENHANCE_YOUR_CALM`, so 60 s is the floor to keep.
- **Self-referencing URL**: `NOTIFICATION_SERVICE_URL` must be reachable from GCP Cloud Tasks (public or VPC-connected).
- **Dispatch deadline**: Cloud Tasks caps each attempt at 10 min by default (max 30 min). `ScheduleRequestDto.timeout` (seconds) sets the relay task's `dispatchDeadline` per-request; `DEFAULT_TIMEOUT_SECONDS` env var provides a service-wide default. Meta-task callbacks keep the 10 min default — they only recompute + reschedule, so they should return quickly. Any single HTTP target call that can exceed 30 min requires an async fire-and-forget pattern (return 202 quickly, complete the work out of band).

## Related Files

| File | Role |
|------|------|
| `src/modules/gcp-scheduling/gcp-scheduling.module.ts` | Module registration, Redis cache config |
| `src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` | Core scheduling logic, meta-job creation |
| `src/modules/gcp-scheduling/cloud-tasks-client.holder.ts` | Cloud Tasks client lifecycle: keepalive, deadline, rebuild, retry |
| `src/modules/gcp-scheduling/gcp-task-relay.service.ts` | Relay callback handler |
| `src/modules/gcp-scheduling/meta.service.ts` | Meta-task callback handler |
| `src/modules/gcp-scheduling/gcp-task-relay.controller.ts` | `/relay` endpoint |
| `src/modules/gcp-scheduling/meta.controller.ts` | `/meta/:ufid` endpoint |
| `src/modules/gcp-scheduling/dto/` | Payload DTOs for relay and meta tasks |
| `src/common/services/schedule.helper.service.ts` | CRON/RRule parsing |
