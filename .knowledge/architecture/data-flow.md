---
description: Request lifecycle from SDK emit through scheduler dispatch to HTTP target execution
---

# Architecture: Data Flow

## Scope

The end-to-end path of a scheduling request from client emission to target URL execution.

## Responsibilities

This document traces how data transforms as it moves through the system, covering both the SDK-side preparation and the service-side execution.

## Non-goals

Does not cover infrastructure deployment, monitoring, or the specifics of GCP Cloud Tasks internals.

## Key Constraints

- All communication is HTTP-based (no gRPC, no message queues).
- The SDK always sends to `POST /schedule`; cancellations go to `DELETE /schedule/:id`.
- The service responds `202 Accepted` on successful scheduling (not 200).

## System Interactions

### Phase 1: SDK Event Preparation

```python
# In typed_client.py
client.emit("event_name", data)
    → EventConfig.prepare(data) → PreparedEventData
    → merge with config defaults (target, method)
    → LowLevelClient.send_schedule_request()
    → POST /schedule with ScheduleRequest body
```

The `prepare()` function is user-defined per event type. It transforms domain data into HTTP components: `payload`, `headers`, `params`, and optionally a `schedule` and `queue` override.

`LowLevelClient` serializes the request via `dataclasses.asdict()`, manually converting enums to `.value` strings and stripping `None` fields.

### Phase 2: Service Request Handling

```
JobSchedulingController.scheduleJob(dto: ScheduleRequestDto)
    → JobSchedulingService.scheduleJobProcessing(dto)
    → IJobScheduler.scheduleJob(dto)
```

`ScheduleRequestDto` (`src/common/dto/schedule-request.dto.ts`) is a discriminated union validated by `class-transformer`. The `schedule` field is either absent (immediate), `OneTimeScheduleDto` (type=ON), or `RecurringScheduleDto` (type=RECURRING).

### Phase 3: Scheduler Dispatch

**GCP path** (`gcp-task.scheduler.service.ts`):
1. `computeNextExecutionTime()` uses `ScheduleHelperService` to parse CRON/RRule and find next occurrence.
2. If within 30 days → `createRelayEndpointTask()` creates a GCP task targeting `/relay` on the service itself.
3. If beyond 30 days → `createMetaEndpointTask()` creates a meta-task targeting `/meta/:ufid`, storing UFID→GCP Task ID in Redis.
4. Returns job ID (UFID for meta-jobs, GCP task name segment for direct relay).

**In-memory path** (`in-memory.scheduler.service.ts`):
1. Immediate → `setTimeout(0)` then `executeJob()`.
2. One-time → `setTimeout(delay)` then `executeJob()`.
3. Recurring → `scheduleNextRecurringInstance()` chains timeouts.

### Phase 4: Target Execution

Both paths ultimately call `HttpExecutorService.executeHttpRequest()` (`src/common/services/http-executor.service.ts`), which:
1. Injects `X-Notitia-Task-ID` header with the job ID.
2. Sends the HTTP request via axios to the target URL with the configured method, payload, headers, and params.
3. Logs request duration and any errors.

For recurring jobs, after execution the scheduler computes the next occurrence and re-schedules.

## Failure Modes

- **SDK**: Non-202 responses raise `NotitiaError` with status, message, and response data. No automatic retries.
- **GCP relay/meta**: GCP Cloud Tasks handles retries per queue config. The service itself does not retry.
- **In-memory**: Errors in `executeJob()` are caught and logged but not retried.
- **Schedule exhaustion**: When a recurring schedule has no more occurrences, `ScheduleHelperService` returns `null` and the job quietly stops.

## Related Knowledge

- [System Overview](system-overview.md) — overall architecture
- [GCP Scheduling](../subsystems/gcp-scheduling.md) — GCP-specific details
- [API Contract](../conventions/api-contract.md) — DTO shapes and endpoints
