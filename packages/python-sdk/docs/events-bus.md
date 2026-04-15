# EventsBus Guide

The `EventsBus` is a domain-driven event system built on top of Notitia. It lets you define events with handlers that can execute locally or be scheduled for deferred execution through the Notitia service.

## Overview

```
Your application                    Notitia service
┌──────────────────────┐           ┌───────────────────┐
│  EventsBus subclass  │           │                   │
│                      │  emit_    │  POST /schedule   │
│  emit_now() ─────────┼─ local ─> │  ───────────────> │
│  emit_scheduled() ───┼─ HTTP ──> │  stores job       │
│                      │           │                   │
│  handler methods  <──┼─ webhook  │  at scheduled     │
│                      │  callback │  time, POSTs back │
└──────────────────────┘           └───────────────────┘
```

- `emit_now()` executes handlers immediately in the current event loop
- `emit_scheduled()` sends the event to Notitia, which calls back your webhook at the scheduled time

## Defining Events

Subclass `EventsBus` and create an inner `Event` enum. Use enum members as decorators to register handler methods.

```python
from notitia.events import EventsBus

class UserLifecycle(EventsBus):
    class Event(EventsBus.Event):
        WELCOME = "welcome"
        WEEKLY_DIGEST = "weekly_digest"
        ACCOUNT_INACTIVE = "account_inactive"

    @Event.WELCOME
    async def on_welcome(self, user_id: str):
        await send_welcome_email(user_id)

    @Event.WEEKLY_DIGEST
    async def on_weekly_digest(self, user_id: str):
        await generate_and_send_digest(user_id)

    @Event.ACCOUNT_INACTIVE
    async def on_account_inactive(self, user_id: str):
        await send_inactivity_notification(user_id)
```

### Queue Routing

Set `__notitia_queue__` on the `Event` class to route all events from this bus to a specific Notitia queue:

```python
class UserLifecycle(EventsBus):
    class Event(EventsBus.Event):
        __notitia_queue__ = "lifecycle-user"
        WELCOME = "welcome"
```

### External Handlers

You can also register handlers outside the class using the `@on()` decorator:

```python
@UserLifecycle.on(UserLifecycle.Event.WELCOME)
async def send_analytics_event(user_id: str):
    await track("user_welcomed", user_id)
```

## Configuration

Call `EventsBus.configure()` once at application startup:

```python
from notitia import NotitiaClient, NotitiaClientConfig
from notitia.events import EventsBus, JsonSerializer

client = NotitiaClient({}, NotitiaClientConfig(base_url="http://localhost:60000"))

EventsBus.configure(
    client=client,
    webhook_target="https://your-app.com/notitia/",
    serializer=JsonSerializer(signing_key="your-secret-key"),  # Optional
    state_tracker=None,  # Optional, see State Tracking below
)
```

| Parameter        | Required | Default              | Description                                                   |
| ---------------- | -------- | -------------------- | ------------------------------------------------------------- |
| `client`         | Yes      | —                    | A `NotitiaClient` instance                                    |
| `webhook_target` | Yes      | —                    | URL where Notitia will POST scheduled events back to your app |
| `serializer`     | No       | `JsonSerializer()`   | Serializer for event arguments                                |
| `state_tracker`  | No       | `NoOpStateTracker()` | Tracks scheduled event state on domain objects                |

## Emitting Events

### Local Execution

```python
lifecycle = UserLifecycle()
await lifecycle.emit_now(UserLifecycle.Event.WELCOME, "user-123")
```

Handlers are called directly in the current event loop. No HTTP request to Notitia is made.

### Scheduled Execution

```python
from datetime import datetime, timedelta

lifecycle = UserLifecycle()

# Schedule for 1 hour from now
job_id = await lifecycle.emit_scheduled(
    UserLifecycle.Event.WELCOME,
    "user-123",
    when=timedelta(hours=1),
)

# Schedule for a specific time
job_id = await lifecycle.emit_scheduled(
    UserLifecycle.Event.WEEKLY_DIGEST,
    "user-123",
    when=datetime(2025, 12, 25, 10, 0),
)

# Recurring (CRON)
job_id = await lifecycle.emit_scheduled(
    UserLifecycle.Event.WEEKLY_DIGEST,
    "user-123",
    when="0 9 * * 1",  # Every Monday at 9am
)
```

### The `when` Parameter

The `when` parameter accepts multiple types via `WhenType`:

| Type                | Example                              | Behavior                                         |
| ------------------- | ------------------------------------ | ------------------------------------------------ |
| `"now"`             | `when="now"`                         | Dispatch immediately (1-second delay)            |
| `datetime`          | `when=datetime(2025, 12, 25, 10, 0)` | Execute at specific UTC time                     |
| `timedelta`         | `when=timedelta(hours=1)`            | Execute relative to now                          |
| `int`               | `when=1735128000`                    | Unix timestamp                                   |
| `str`               | `when="0 9 * * 1"`                   | CRON or RRULE recurrence string                  |
| `pendulum.DateTime` | `when=pendulum.now("US/Eastern")`    | Pendulum datetime (requires `notitia[pendulum]`) |

### Cancellation

```python
await lifecycle.cancel_scheduled(UserLifecycle.Event.WEEKLY_DIGEST)
```

Cancellation requires a `StateTracker` that tracks which job ID is associated with each event. With the default `NoOpStateTracker`, cancellation will log a warning because no job ID can be found. Use `BeanieStateTracker` or implement your own `StateTracker` for production use.

Pass `silent=True` to suppress the warning:

```python
await lifecycle.cancel_scheduled(UserLifecycle.Event.WEEKLY_DIGEST, silent=True)
```

## The `resolve()` Pattern

When scheduling events on domain objects (e.g., a User model), you often need to reconstruct the object when the event fires later. Override `resolve()` to handle this:

```python
class UserLifecycle(EventsBus):
    class Event(EventsBus.Event):
        WELCOME = "welcome"

    @classmethod
    async def resolve(cls, entity_id: str) -> "User":
        return await User.get(entity_id)

    @Event.WELCOME
    async def on_welcome(self, user):
        await send_welcome_email(user.email)
```

When `resolve()` is overridden and the first argument to `emit_scheduled()` is an `EventsBus` instance with an `id` attribute:

1. On scheduling: the object's `id` is serialized instead of the full object
2. On webhook callback: `resolve(entity_id)` is called to reconstruct the object before invoking handlers

This ensures handlers always get a fresh, up-to-date domain object.

## Serialization

Event arguments must be serializable for scheduled events (they travel through Notitia and back via webhook).

### JsonSerializer (default)

Uses stdlib `json`. Handles JSON-serializable types (strings, numbers, dicts, lists).

```python
from notitia.events import JsonSerializer

# Without signing (default)
serializer = JsonSerializer()

# With HMAC-SHA256 signing (recommended for production)
serializer = JsonSerializer(signing_key="your-secret-key")
```

When a `signing_key` is set, payloads are signed and verified on deserialization. This prevents tampering with event data in transit.

### Custom Serializer

Implement the `EventSerializer` protocol for custom serialization:

```python
from notitia.events import EventSerializer

class MySerializer:
    def serialize(self, *args, **kwargs) -> str:
        # Return a string representation of the arguments
        ...

    async def deserialize(self, payload: str) -> tuple[tuple, dict]:
        # Return (args, kwargs)
        ...
```

See [Contrib integrations](contrib.md) for `BeanieAwareSerializer`, which handles MongoDB document references.

## State Tracking

The `StateTracker` protocol tracks which events are scheduled, executed, or cancelled on domain objects.

### NoOpStateTracker (default)

Does nothing. Use this when you don't need to track event state or handle cancellation by event name.

### Custom StateTracker

Implement the `StateTracker` protocol:

```python
from notitia.events import StateTracker

class MyStateTracker:
    async def on_event_scheduled(self, target, event_name: str, job_id: str, when) -> None:
        # Called after an event is scheduled
        ...

    async def on_event_executed(self, target, event_name: str, job_id: str) -> None:
        # Called when a scheduled event fires via webhook
        ...

    async def on_event_cancelled(self, target, event_name: str, job_id: str) -> None:
        # Called after an event is cancelled
        ...

    async def get_scheduled_event_job_id(self, target, event_name: str) -> str | None:
        # Look up the job ID for a scheduled event (needed for cancellation)
        ...
```

See [Contrib integrations](contrib.md) for `BeanieStateTracker`, which persists state on MongoDB documents.

## Business Hours Scheduling

The `schedule_business_hours()` helper creates a datetime targeting a specific business hour in a user's timezone. Requires `notitia[pendulum]`.

```python
from notitia.events import schedule_business_hours

# Schedule for tomorrow at 9:30 AM in the user's timezone
when = schedule_business_hours(
    user_tz="Europe/Rome",
    days_offset=1,
    hour=9,
    minute=30,
    weekend_mode="before",  # If it lands on a weekend: "before" (Friday), "after" (Monday), "ignore"
)

job_id = await lifecycle.emit_scheduled(
    UserLifecycle.Event.WEEKLY_DIGEST,
    "user-123",
    when=when,
)
```

| Parameter      | Default         | Description                      |
| -------------- | --------------- | -------------------------------- |
| `user_tz`      | `"Europe/Rome"` | IANA timezone string             |
| `days_offset`  | `0`             | Days from now (or `start_date`)  |
| `hour`         | `9`             | Hour in 24h format               |
| `minute`       | `30`            | Minute                           |
| `weekend_mode` | `"before"`      | How to handle weekends           |
| `start_date`   | Now             | Base date for offset calculation |
