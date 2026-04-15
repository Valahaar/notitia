---
description: In-memory scheduler for dev/test — setTimeout-based execution with no persistence
---

# Subsystem: In-Memory Scheduling

## Purpose

Lightweight scheduler for local development and testing that requires no external infrastructure (no GCP, no Redis). Uses Node.js `setTimeout` to delay job execution.

## Core Abstractions

- **`InMemorySchedulerService`** (`src/modules/in-memory-scheduling/in-memory.scheduler.service.ts`) — Implements `IJobScheduler`. Manages a `Map<string, NodeJS.Timeout>` of active jobs.
- **`InMemorySchedulingModule`** (`src/modules/in-memory-scheduling/in-memory-scheduling.module.ts`) — Registers the service and provides it as `JOB_SCHEDULER_TOKEN`.

## Invariants

- Job IDs are UUIDs generated at schedule time.
- Each scheduled job has exactly one active timeout in the map.
- Cancellation clears the timeout and removes the map entry.
- Recurring jobs chain: after each execution, `scheduleNextRecurringInstance()` computes the next time and sets a new timeout.

## External Dependencies

- **`ScheduleHelperService`** (`src/common/services/schedule.helper.service.ts`) — Shared CRON/RRule parser for computing next execution times.
- **`HttpExecutorService`** (`src/common/services/http-executor.service.ts`) — Executes the HTTP call to the target URL.

## Integration Points

- Activated when `SCHEDULER_TYPE=in-memory` environment variable is set (checked in `src/app.module.ts`).
- The `docker-compose.yml` `service-in-memory` variant sets this automatically.
- Uses the same `IJobScheduler` interface as the GCP scheduler — fully interchangeable.

## Known Pitfalls

- **No persistence**: All scheduled jobs are lost on process restart. This is by design for dev use only.
- **No retries**: `executeJob()` catches errors and logs them but does not retry. Contrast with GCP Cloud Tasks which retries per queue config.
- **Timer drift**: For long delays, `setTimeout` accuracy degrades. Not a concern for dev/test scenarios.
- **`queue` field ignored**: The in-memory scheduler has no concept of queues; the field is silently dropped.
- **Memory growth**: Long-running processes with many recurring jobs accumulate timeout references. No cleanup mechanism beyond cancellation.

## Related Files

| File | Role |
|------|------|
| `src/modules/in-memory-scheduling/in-memory.scheduler.service.ts` | Scheduler implementation |
| `src/modules/in-memory-scheduling/in-memory-scheduling.module.ts` | Module registration |
| `src/common/interfaces/job-scheduler.interface.ts` | Shared `IJobScheduler` interface |
| `docker-compose.yml` | `service-in-memory` variant |
