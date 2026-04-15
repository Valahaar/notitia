# Notitia Service - GCP Cloud Tasks Design

## 1. Introduction

This document details the design of the Google Cloud Tasks (GCP) integration for the Notitia service. Notitia uses GCP Cloud Tasks as its primary distributed task scheduler for reliable execution of HTTP calls.

The core idea is to leverage GCP Cloud Tasks for its robustness. However, GCP Cloud Tasks has a maximum scheduling horizon (currently 30 days in the future). To support schedules beyond this limit and to handle recurring tasks, a "meta-job" system is implemented.

## 2. Key Components

*   **`GcpTaskSchedulerService`**: The main service responsible for interfacing with GCP Cloud Tasks. It decides whether a job can be scheduled directly or requires a meta-job.
*   **`MetaService`**: Handles the logic for meta-jobs. When a meta-job task fires, this service determines if the original job should be executed or if another meta-job needs to be scheduled.
*   **`GcpTaskRelayService`**: Executes the actual HTTP call to the target URL when a direct task or an occurrence from a meta-job is due.
*   **`MetaController` (`/meta/{ufid}`)**: An internal HTTP endpoint that GCP Cloud Tasks calls to trigger `MetaService`.
*   **`GcpTaskRelayController` (`/relay`)**: An internal HTTP endpoint that GCP Cloud Tasks calls to trigger `GcpTaskRelayService` for actual HTTP call execution. As Notitia service sits on the perimeter, it is publicly accessible by GCP Cloud Tasks. This `/relay` endpoint thus also acts as a crucial proxy: it receives requests from the external Cloud Tasks service and can then forward them to internal services that Notitia has access to, but Cloud Tasks cannot directly reach.
*   **Redis Cache**: Used to store mappings between User-Friendly IDs (`UFID`) and the actual GCP Task IDs for meta-jobs. This is crucial for managing and canceling meta-jobs.

## 3. Core Concepts

### 3.1. User-Friendly ID (UFID)

For jobs that require the meta-job flow (long-term one-time or any recurring job), a `UFID` is generated. This `UFID` is returned to the client and acts as the persistent identifier for the entire lifecycle of that job, even if multiple underlying GCP tasks are created and destroyed for it over time.
For direct, short-term, one-time jobs, the GCP Task ID itself is returned to the client.

### 3.2. GCP Queues

Two main GCP Cloud Task queues are utilized:

1.  **Job Queue (`gcpJobQueue`)**: Used for tasks that will directly hit the `/relay` endpoint to execute an HTTP call. These are either:
    *   Immediate tasks.
    *   One-time tasks schedulable within GCP's 30-day limit.
    *   Actual execution tasks triggered by the `MetaService`.
2.  **Meta Job Queue (`gcpMetaJobQueue`)**: Used for tasks that will hit the `/meta/{ufid}` endpoint. These tasks represent:
    *   One-time jobs scheduled beyond GCP's 30-day limit.
    *   Recurring jobs.

The payload for tasks on the `gcpJobQueue` (targeting `/relay`) is `GcpTaskRelayPayloadDto`.
The payload for tasks on the `gcpMetaJobQueue` (targeting `/meta/{ufid}`) is the original `ScheduleRequestDto` (plus an `isOccurrence` flag).

### 3.3. `isOccurrence` Flag

This boolean flag is added to the `ScheduleRequestDto` when it's passed as a payload to a meta-job. It helps the `MetaService` determine if the current invocation of the meta-job is the actual intended execution time (i.e., an "occurrence" of the schedule) or if it's an intermediate step in a long-term schedule.
*   `isOccurrence: true`: The meta-job should trigger the actual HTTP call via the `/relay` endpoint now.
*   `isOccurrence: false`: The meta-job is for a future event that is still beyond the direct scheduling limit. It should re-schedule another meta-job for a closer future date.

## 4. Job Scheduling Flows

When a `ScheduleRequestDto` is received by `GcpTaskSchedulerService.scheduleJob()`:

1.  **Compute Next Execution Time**: `GcpTaskSchedulerService.computeNextExecutionTime(request)` is called. This method:
    *   Calculates the `realNextExecutionTime` based on the user's schedule (e.g., CRON, specific datetime).
    *   Calculates `nextExecutionTime` by clamping `realNextExecutionTime` to GCP's maximum schedulable time from now (using `GcpTaskSchedulerService.restrictScheduleTime()`).
    *   Determines if the job is `recurring`.
    *   Sets `nextIsOccurrence = (nextExecutionTime === realNextExecutionTime)`. This flag indicates if the *clamped* schedule time is the *actual* intended schedule time.

2.  **Decision Logic (`scheduleInternal` method)**:

    *   **Case 1: Direct Relay Task (No Meta-Job Needed)**
        *   **Condition**: The job is *not* recurring AND (`nextExecutionTime` exists AND `nextIsOccurrence` is true) OR (`nextExecutionTime` is undefined, meaning an immediate job).
        *   **Action**: Schedule a task directly on `gcpJobQueue` targeting the `/relay` endpoint.
            *   The `GcpTaskRelayPayloadDto` is constructed from the original request.
            *   The `scheduleTime` for this GCP task is `nextExecutionTime` (or ASAP if undefined).
        *   **Returned ID**: The GCP Task ID of this relay task.
        *   **Log**: "Scheduling direct relay task..."

    *   **Case 2: Meta-Job Task (Long-Term or Recurring)**
        *   **Condition**: The job is `recurring` OR (it's a one-time job where `nextIsOccurrence` is false, meaning `realNextExecutionTime` is beyond the 30-day limit).
        *   **Pre-check**: If `nextExecutionTime` is not defined (shouldn't happen for recurring/long-term if correctly processed), an error is thrown.
        *   **Action**:
            1.  Generate a `ufid` (e.g., `generateNumericId()`).
            2.  Schedule a task on `gcpMetaJobQueue` targeting `/meta/{ufid}`.
                *   The payload is the original `ScheduleRequestDto` augmented with `{ isOccurrence: nextIsOccurrence }`.
                *   The `scheduleTime` for this GCP meta-task is `nextExecutionTime`.
            3.  Store the mapping: `ufid` -> (GCP Meta Task ID) in Redis using `setIdForUfid()`.
        *   **Returned ID**: The `ufid`.
        *   **Log**: "Scheduling meta-job..."

## 5. GCP Task Execution Flows

### 5.1. Relay Task Execution (`/relay` endpoint)

1.  GCP Cloud Tasks calls the `/relay` endpoint with `GcpTaskRelayPayloadDto`. This endpoint is publicly accessible to GCP Cloud Tasks because Notitia service is deployed at the network perimeter.
2.  `GcpTaskRelayController.handleGcpTask()` receives the payload.
3.  It calls `GcpTaskRelayService.executeTask()`.
4.  `GcpTaskRelayService` uses `axios` to make the HTTP call to the `originalTarget` specified in the payload, with the given `method`, `payload`, `headers`, and `params`. This `originalTarget` can be an internal service, effectively making the `/relay` endpoint a proxy.
5.  **Response Handling**:
    *   If `axios` succeeds (2xx response from the target), `GcpTaskRelayService` logs success. The controller returns HTTP `200 OK` to GCP, and the GCP task is considered complete.
    *   If `axios` fails (e.g., network error, non-2xx response from target), `GcpTaskRelayService` re-throws the `AxiosError`.
    *   `GcpTaskRelayController` catches this error and converts it into an `HttpException` (e.g., 500, or the status from `axiosError.response.status` if available). This non-2xx response signals to GCP Cloud Tasks that the task failed and should be retried according to the queue's retry policy.

### 5.2. Meta Task Execution (`/meta/{ufid}` endpoint)

1.  GCP Cloud Tasks calls the `/meta/{ufid}` endpoint. The body of this POST request is the `ScheduleRequestDto` (with `isOccurrence`) that was originally scheduled for this meta-job.
2.  `MetaController.processMetaJob()` receives the `ufid` and the original request payload.
3.  It calls `MetaService.processMetaJob(ufid, originalRequest)`.
4.  **`MetaService` Logic**:
    a.  **Cache Check**: Retrieve the stored GCP Task ID for the `ufid` from Redis using `gcpTaskScheduler.getIdFromUfid(ufid)`. If not found, log a warning (job might be stale/cancelled) and return (implicitly HTTP 200 to GCP to prevent retries for an unrecognized job).
    b.  **Re-compute Next Execution**: Call `gcpTaskScheduler.computeNextExecutionTime(originalRequest)` again. This is crucial because time has passed, and the *next* actual execution time or *next* clamped time might be different. This yields new `nextExecutionTime`, `realNextExecutionTime`, `recurring`, and `nextIsOccurrence` values.
    c.  **Handle Recurring Jobs**:
        i.  **Execute Current Occurrence (if applicable)**: If `originalRequest.isOccurrence` was true (meaning the meta-task firing *was* for an actual scheduled time), then `gcpTaskScheduler.createRelayEndpointTask(executionPayload)` is called to dispatch the actual HTTP call immediately.
        ii. **Reschedule Next Occurrence**: If `recurring` is true AND the new computation yields a future `nextExecutionTime`:
            *   A *new* meta-task is created using `gcpTaskScheduler.createMetaEndpointTask(ufid, { ...originalRequest, isOccurrence: newNextIsOccurrence }, newNextExecutionTime)`. Note that the *same UFID* is used.
            *   The `ufid` -> (new GCP Meta Task ID) mapping is updated in Redis.
            *   Log: "Re-scheduled recurring meta-job..."
        iii. **End of Recurrence**: If `recurring` is true but the new computation yields no `nextExecutionTime` (e.g., CRON job with an end date that has passed, or RRule with a COUNT that has been met), the `ufid` is deleted from Redis using `gcpTaskScheduler.delUfid(ufid)`. Log: "Recurring job has no further occurrences. Clearing cache."

    d.  **Handle Long-Term One-Time Jobs (Non-Recurring Path)**:
        i.  **Final Execution**: If `newNextIsOccurrence` is true (meaning the `realNextExecutionTime` is now within GCP's 30-day direct scheduling limit):
            *   A direct relay task is scheduled: `gcpTaskScheduler.createRelayEndpointTask(originalRequest)`.
            *   The `ufid` -> (new GCP Relay Task ID) mapping is updated in Redis. Note: This maps the UFID to the *final* relay task ID.
            *   Log: "Scheduled actual relayed task..."
        ii. **Reschedule Intermediate Meta-Job**: If `newNextIsOccurrence` is false (meaning the `realNextExecutionTime` is still beyond the direct scheduling limit):
            *   A *new* meta-task is scheduled: `gcpTaskScheduler.createMetaEndpointTask(ufid, { ...originalRequest, isOccurrence: newNextIsOccurrence }, newNextExecutionTime)`.
            *   The `ufid` -> (new GCP Meta Task ID) mapping is updated in Redis.
            *   Log: "Re-scheduled meta-job..."

5.  **Controller Response**: If `MetaService.processMetaJob` completes successfully, `MetaController` returns HTTP `200 OK` to GCP. If an error occurs within `MetaService`, it's propagated, and `MetaController` returns an appropriate non-2xx status (e.g., `InternalServerErrorException`), causing GCP to retry the meta-task.

## 6. Job Cancellation Flow (`GcpTaskSchedulerService.cancelJob()`)

When `cancelJob(jobId)` is called:

1.  **Identify Job Type**: The `jobId` can either be a direct GCP Task ID or a `UFID`.
    *   Attempt to get a GCP Task ID from Redis using `getIdFromUfid(jobId)`. If successful, `jobId` was a `UFID` for a meta-job, and `gcpTaskIdFromCache` is the ID of the *current* GCP meta-task associated with it.
The queue is `gcpMetaJobQueue`.
    *   If `getIdFromUfid(jobId)` returns null/undefined, assume `jobId` is a direct GCP Task ID. The queue is `gcpJobQueue`.

2.  **Determine Actual GCP Task ID**: `actualJobId` is either `gcpTaskIdFromCache` or the original `jobId`.

3.  **Construct Task Path**: `const name = this.getTaskPath(queue, actualJobId);`

4.  **Delete GCP Task**: Call `this.cloudTasksClient.deleteTask({ name })`.
    *   **Success**: The task is deleted. If `gcpTaskIdFromCache` existed (meaning it was a meta-job identified by its UFID), then `delUfid(jobId)` is called to remove the UFID mapping from Redis. Returns `true`.
    *   **Failure (Not Found)**: If GCP returns an error with code `5` (NOT_FOUND), log a warning. The task is already gone. If `gcpTaskIdFromCache` existed, still remove the UFID mapping from Redis. Returns `true` (as the goal of cancellation is achieved).
    *   **Failure (Other Error)**: Log the error. Do not delete from Redis (as the GCP task might still exist). Returns `false`.

## 7. Important Considerations

*   **Idempotency**: The `/meta/{ufid}` and `/relay` endpoints should ideally be idempotent, although GCP's at-least-once delivery handles retries. The current design relies on GCP's task deduplication and the Redis cache state for managing meta-job progression.
*   **Error Handling**: Non-2xx responses from `/meta` and `/relay` endpoints are crucial for signaling GCP to retry tasks.
*   **Cache Consistency**: The Redis cache holding UFID-to-GCP-Task-ID mappings is critical. If this cache becomes inconsistent with the state in GCP, meta-jobs might not be processed or cancelled correctly. Standard cache eviction/TTL policies for Redis are not explicitly used for these mappings as they are actively managed (deleted upon completion/cancellation).
*   **Configuration**: Correct configuration of `GCP_PROJECT_ID`, `GCP_LOCATION_ID`, `GCP_JOB_QUEUE_NAME`, `GCP_META_JOB_QUEUE_NAME`, and `NOTIFICATION_SERVICE_URL` (for constructing callback URLs for GCP tasks) is essential.
*   **GCP_MAX_SCHEDULE_SECONDS**: This constant defines the 30-day window and is fundamental to the meta-job logic.

This design ensures that the service can handle a wide variety of scheduling needs while abstracting the complexities of GCP Cloud Tasks limitations from the end-user.
