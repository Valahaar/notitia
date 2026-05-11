---
description: Typed async Python SDK — event prepare pattern, LowLevelClient HTTP wrapper, NotitiaClient generic interface
---

# Subsystem: Python SDK

## Purpose

Provides Python applications with a typed, async interface to schedule notifications and jobs via the Notitia service. Decouples domain event logic from HTTP transport through a prepare-function pattern.

## Core Abstractions

- **`NotitiaClient[EventNameT]`** (`src/notitia/typed_client.py`) — Generic high-level client parameterized by an event name type (typically an Enum). Holds a registry of `EventConfig` definitions and exposes `emit(event_name, data)` and `cancel(job_id)`.
- **`LowLevelClient`** (`src/notitia/low_level_client.py`) — Async HTTP wrapper over `httpx.AsyncClient`. Handles serialization, auth headers, and the `POST /schedule` / `DELETE /schedule/:id` calls.
- **`RetryConfig`** (`src/notitia/retry.py`) — Frozen dataclass holding retry policy (`max_attempts`, `base_delay`, `max_delay`, `jitter`, `max_retry_after`, `retry_status_codes`). Wired into `NotitiaClientConfig.retry` and consumed by `LowLevelClient._send_with_retries`.
- **`NotitiaError`** (`src/notitia/low_level_client.py`) — Exception carrying message, HTTP status, response data, and optional cause.
- **`EventConfig[PA]`** (`src/notitia/types.py`) — Per-event configuration: a `prepare` callable, default `target` URL, and default `method`.
- **`PreparedEventData`** (`src/notitia/types.py`) — Output of `prepare()`: payload, headers, params, schedule, and optional method/target/queue overrides.
- **`ScheduleRequest`** (`src/notitia/common_types.py`) — Low-level DTO matching the service's `ScheduleRequestDto`. Includes `timeout: Optional[int]` (seconds, 15–1800) — the SDK field is snake_case but matches the service's camelCase `timeout` on the wire since both happen to be a single word. Maps to the Cloud Tasks dispatch deadline on the GCP scheduler.
- **`Schedule`** (`src/notitia/common_types.py`) — Union of `OneTimeSchedule` (ISO 8601 time) and `RecurringSchedule` (CRON/RRule pattern), discriminated by `ScheduleType`.

## Invariants

- `emit()` always calls the event's `prepare()` function before sending — no raw payloads bypass preparation.
- `LowLevelClient` expects 202 for schedule success and 200 for cancel success; anything else raises `NotitiaError`.
- Enum fields are manually converted to `.value` strings during serialization (`dataclasses.asdict()` doesn't handle this).
- `None` values are stripped from the serialized dict at both top-level and nested schedule level.
- `LowLevelClient` retries 429 and 5xx responses by default (5 attempts, exponential backoff with equal jitter). On 429, honors `Retry-After`, `RateLimit-Reset`, `X-RateLimit-Reset` headers (max wins, capped at 60s). Network errors are NOT retried. Retry-exhaustion surfaces as the existing `NotitiaError`.

## External Dependencies

- **`httpx`** — Async HTTP client (the only runtime dependency).
- **Notitia service** — The SDK targets `POST /schedule` and `DELETE /schedule/:id` endpoints.

## Integration Points

Usage pattern in consuming applications:

```python
from notitia import NotitiaClient, EventConfig, PreparedEventData

class AppEvent(str, Enum):
    USER_CREATED = "user_created"

def prepare_user_created(data: UserData) -> PreparedEventData:
    return PreparedEventData(
        payload={"user_id": data.id, "email": data.email},
        headers={"X-Custom": "value"},
    )

client = NotitiaClient[AppEvent](
    config=NotitiaConfig(base_url="https://notitia.example.com", token="..."),
    event_definitions={
        AppEvent.USER_CREATED: EventConfig(
            prepare=prepare_user_created,
            target="https://webhook.example.com/users",
        ),
    },
)

job_id = await client.emit(AppEvent.USER_CREATED, user_data)
await client.cancel(job_id)
await client.close()
```

Advanced usage with `Literal` overloads on a subclass provides per-event type safety for the `data` parameter (see `examples/advanced/client.py`).

## Known Pitfalls

- **No context manager**: Must manually call `await client.close()` to release the `httpx.AsyncClient`.
- **Runtime vs static typing**: `Literal` overloads provide IDE autocomplete but no runtime enforcement — passing wrong event types only fails if the event name isn't in `_event_definitions`.
- **404 on cancel**: Code currently raises `NotitiaError` on 404, but a comment suggests this may change to treat 404 as success (job already gone).
- **Timeout configuration**: `NotitiaConfig.timeout` sets `httpx` timeout; defaults may be too short for slow networks.
- **Enum string duality**: `emit()` checks `hasattr(event_name, "value")` to handle both raw strings and Enum members — callers can use either.
- **Retry by default**: `NotitiaClientConfig` enables retries automatically. Callers that need fail-fast must set `retry=RetryConfig(max_attempts=1)`.
- **Server delay cap**: A server-supplied retry delay above `RetryConfig.max_retry_after` (default 60s) causes the SDK to surface the 429 immediately instead of blocking.

## Events Layer (`notitia.events`)

The SDK includes an optional events layer that provides a framework-agnostic `EventsBus` for event-driven architectures built on top of Notitia scheduling. See `.knowledge/subsystems/events-bus.md` for full details.

Key integration point: `EventsBus.configure()` registers an internal `_notitia_bus_event` `EventConfig` on the user's `NotitiaClient`, using the existing `prepare()` → `emit()` flow. No changes to `NotitiaClient` or `LowLevelClient` were needed.

## Related Files

| File | Role |
|------|------|
| `packages/python-sdk/src/notitia/__init__.py` | Package exports |
| `packages/python-sdk/src/notitia/typed_client.py` | `NotitiaClient` high-level interface |
| `packages/python-sdk/src/notitia/low_level_client.py` | HTTP transport, serialization, error handling |
| `packages/python-sdk/src/notitia/types.py` | `EventConfig`, `PreparedEventData` |
| `packages/python-sdk/src/notitia/common_types.py` | `ScheduleRequest`, `Schedule`, `HttpMethod` |
| `packages/python-sdk/src/notitia/retry.py` | `RetryConfig` and retry/backoff helpers |
| `packages/python-sdk/src/notitia/events/` | EventsBus core — bus, event enum, serialization, scheduling, state tracking |
| `packages/python-sdk/src/notitia/contrib/` | Framework adapters — FastAPI router, Beanie state tracker |
| `packages/python-sdk/examples/basic.py` | Simple usage example |
| `packages/python-sdk/examples/advanced/` | Typed client with `Literal` overloads |
| `packages/python-sdk/examples/complex/` | Full EventsBus integration example (FastAPI + Beanie) |
| `packages/python-sdk/tests/` | pytest unit and respx-based integration tests |
| `packages/python-sdk/README.md` | SDK documentation |
