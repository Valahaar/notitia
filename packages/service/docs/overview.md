# Notitia Service Overview

## 1. Introduction

Notitia is a microservice designed to schedule and execute HTTP calls. It allows users to submit requests for HTTP calls to be made immediately, at a specific future time (one-time), or on a recurring basis (e.g., using CRON or RRule). This service acts as a reliable scheduler for various notification and webhook needs.

## 2. Key Features

*   **Flexible Scheduling**: Supports immediate, one-time, and recurring (CRON/RRule) HTTP calls.
*   **Standard HTTP Methods**: Supports POST, GET, PUT, DELETE, PATCH methods for the target URL.
*   **Custom Payloads & Headers**: Allows sending custom JSON payloads and HTTP headers with the request.
*   **Job Management**: Provides a unique `jobId` for each accepted request, which can be used to cancel scheduled jobs.
*   **Abstracted Complexity**: Manages the complexities of long-term scheduling and recurrence internally, providing a simple interface to the user.

## 3. API Endpoints

The primary interaction with the Notitia service is through its REST API.

### 3.1. Schedule an HTTP Call

*   **Endpoint**: `POST /schedule`
*   **Description**: Submits an HTTP call for immediate, scheduled, or recurring execution.
*   **Request Body**: `ScheduleRequestDto` (see section 4.1)
*   **Response**: `202 Accepted` with a `ScheduleJobResponseDto` containing the `jobId` (see section 5.1).
*   **Error Responses**:
    *   `400 Bad Request`: If the request body is invalid (e.g., missing required fields, malformed schedule).
    *   `500 Internal Server Error`: If an unexpected error occurs on the server.

### 3.2. Cancel a Scheduled HTTP Call

*   **Endpoint**: `DELETE /schedule/:id`
*   **Description**: Cancels a previously scheduled HTTP call on a given `queue`. The `id` can be the `jobId` returned when the job was scheduled.
*   **Path Parameter**:
    *   `id` (string): The ID of the job to cancel.
*   **Query Parameter**:
    *   `queue` (string, optional): The queue from which the job should be canceled.
*   **Response**: `200 OK`
    *   `true`: If the cancellation request was successfully processed (this includes scenarios where the job was already executed, not found, or successfully cancelled).
    *   `false`: If an internal error occurred during the cancellation attempt.
*   **Error Responses**:
    *   `400 Bad Request`: If the `id` is malformed.
    *   `404 Not Found`: While the API aims to return `true` even for not-found jobs to simplify client logic, specific underlying errors might sometimes manifest differently. Generally, a `true` response means the system has processed the cancellation for the given ID.
    *   `500 Internal Server Error`: If an unexpected error occurs during cancellation.

## 4. Request Payloads

### 4.1. `ScheduleRequestDto`

This is the main DTO used for submitting jobs.

```json
{
    "queue": "string", // Optional: queue name (used for logical separation of tasks), defaults to "notitia", but should be specified as a good practice
    "schedule": {
        // Optional: If omitted, the call is immediate.
        // Defines when the call should be made.
    },
    "target": "string (URL)", // Required: The URL to call.
    "method": "string (Enum: POST, GET, PUT, DELETE, PATCH)", // Optional: Defaults to POST.
    "payload": "object", // Optional: JSON payload for methods like POST, PUT, PATCH.
    "headers": "object", // Optional: Key-value pairs for HTTP headers.
    "params": "object" // Optional: Key-value pairs for URL query parameters.
}
```

#### 4.1.1. Schedule Object Types

The `schedule` object, if present, defines the timing of the HTTP call.

**a) One-Time Schedule (`OneTimeScheduleDto`)**

For an HTTP call to be made once at a specific time.

```json
{
    "type": "on", // Required
    "time": "string (ISO 8601 datetime in UTC)" // Required: e.g., "2024-08-15T10:00:00.000Z"
}
```

**Example `ScheduleRequestDto` for a one-time job:**

```json
{
    "schedule": {
        "type": "on",
        "time": "2025-01-01T00:00:00.000Z"
    },
    "target": "https://my-service.com/webhook/new-year",
    "payload": { "message": "Happy New Year!" }
}
```

**b) Recurring Schedule (`RecurringScheduleDto`)**

For an HTTP call to be made on a recurring basis.

```json
{
    "type": "recurring", // Required
    "schedule": "string (CRON or RRule string)" // Required: e.g., "0 0 * * *" (daily at midnight) or "RRULE:FREQ=WEEKLY;BYDAY=MO"
    // complex RRules are to be structured as follows: 'DTSTART;TZID=Europe/Rome:20250630T153000\nRRULE:FREQ=WEEKLY;UNTIL=20251118T225959Z;BYDAY=TU'
}
```

**Example `ScheduleRequestDto` for a recurring job:**

```json
{
    "schedule": {
        "type": "recurring",
        "schedule": "0 9 * * MON-FRI" // Every weekday at 9 AM
    },
    "target": "https://my-service.com/webhook/daily-briefing",
    "method": "POST"
}
```

**c) Immediate Call**

If the `schedule` object is omitted, the HTTP call is queued for immediate execution.

**Example `ScheduleRequestDto` for an immediate job:**

```json
{
    "target": "https://my-service.com/webhook/instant-event",
    "payload": { "data": "some_event_data" }
}
```

## 5. Response Payloads

### 5.1. `ScheduleJobResponseDto`

Returned upon successful job submission (`POST /schedule`).

```json
{
    "jobId": "string" // The unique identifier for the scheduled job.
}
```
**Example:**
```json
{
    "jobId": "c7a0b6e0-0b7a-4a0e-8b0a-0b7a4a0e8b0a"
}
```

## 6. Job Processing Flow (High-Level)

1.  **Submission**: A client sends a `ScheduleRequestDto` to the `POST /schedule` endpoint.
2.  **Validation & Acceptance**: The service validates the request. If valid, it accepts the job and generates a unique `jobId`.
3.  **Acknowledgement**: The service returns a `202 Accepted` response with the `jobId`.
4.  **Scheduling**: The job is handed over to an internal scheduling mechanism.
    *   For **immediate** jobs, the HTTP call is queued for execution as soon as possible.
    *   For **one-time** jobs, the call is scheduled for the specified `time`.
    *   For **recurring** jobs, the first call is scheduled according to the `schedule` string, and subsequent calls are automatically re-scheduled by the system.
5.  **Execution**: At the designated time, the scheduling mechanism triggers the HTTP call to the specified `target` URL with the provided `method`, `payload`, `headers`, and `params`.
6.  **Cancellation**: If a `DELETE /schedule/:id` request is received, the service attempts to find and remove the corresponding job from the scheduling mechanism.

## 7. Configuration (Key Environment Variables)

While most internal configurations are managed by the service deployment, developers should be aware of:

*   `NOTIFICATION_SERVICE_URL`: The base URL of this Notitia service itself. This is used internally for certain types of scheduled tasks (e.g., meta-jobs for long-term scheduling).
*   `SCHEDULER_TYPE`: Determines the backend scheduler (e.g., `gcp` for Google Cloud Tasks, `in-memory` for local development/testing). This is typically set during deployment.

Other environment variables like `REDIS_HOST`, `REDIS_PORT`, and GCP-specific configurations (`GCP_PROJECT_ID`, etc.) are relevant for deployment and operation but not directly for API consumption.

## 8. Error Handling

The service uses standard HTTP status codes for errors.
*   `4xx` errors typically indicate client-side issues (e.g., bad request format, invalid parameters). The response body will often contain a JSON object with `statusCode`, `timestamp`, `path`, `method`, and a `message` detailing the error. For `400 Bad Request` errors, the request `body` might also be included in the error response for debugging.
*   `5xx` errors indicate server-side issues.

The service implements global HTTP exception filtering to provide consistent error responses. Detailed logs are maintained on the server side for troubleshooting.

## 9. Underlying Scheduling Mechanism

The Notitia service employs an abstract job scheduling component. The primary production implementation utilizes **Google Cloud Tasks**. This allows for:

*   Reliable, at-least-once execution of tasks.
*   Scalable handling of a large number of scheduled jobs.
*   Management of retries and error handling for task execution.

For very long-term schedules (e.g., beyond Google Cloud Tasks' direct scheduling limits) or complex recurring patterns, the service uses a "meta-job" strategy. This involves scheduling an internal task that, when executed, either performs the final action or re-schedules another meta-job closer to the actual execution time.

**Developers interacting with the Notitia API do not need to manage these internal details.** The `jobId` provided is the single identifier needed for any interaction (like cancellation). The service ensures that the HTTP call is made as requested, regardless of the internal scheduling strategy employed.
An in-memory scheduler is also available, typically for local development and testing purposes.
