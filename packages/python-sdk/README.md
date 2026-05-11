# Notitia Python SDK

Python client library for the [Notitia](../../README.md) HTTP scheduling service. Schedule immediate, one-time, or recurring HTTP calls from your Python application.

## Installation

```bash
pip install notitia
```

Optional extras for framework integrations:

```bash
pip install notitia[fastapi]    # FastAPI webhook router
pip install notitia[beanie]     # Beanie (MongoDB) state tracker
pip install notitia[pendulum]   # Pendulum datetime support
pip install notitia[all]        # All extras
```

## Configuration

```python
from notitia import NotitiaClientConfig

config = NotitiaClientConfig(
    base_url="http://localhost:60000",   # Notitia service URL
    timeout=10.0,                         # Request timeout in seconds
    default_headers={"Authorization": "Bearer my-token"},
    default_queue="my-queue",             # Optional default queue
)
```

Retries are enabled by default (up to 5 attempts with exponential back-off). To disable or tune them, pass a `RetryConfig`:

```python
from notitia import NotitiaClientConfig
from notitia.retry import RetryConfig

# Disable retries entirely
config = NotitiaClientConfig(base_url="...", retry=RetryConfig(max_attempts=1))

# Custom retry policy
config = NotitiaClientConfig(base_url="...", retry=RetryConfig(max_attempts=3, base_delay=1.0))
```

## Three Abstraction Levels

The SDK provides three ways to interact with Notitia, from low-level to high-level:

### 1. LowLevelClient

Direct HTTP calls to the Notitia service. Use when you want full control over requests.

```python
from notitia import (
    LowLevelClient,
    NotitiaClientConfig,
    ScheduleRequest,
    OneTimeSchedule,
    RecurringSchedule,
    HttpMethod,
)

client = LowLevelClient(NotitiaClientConfig(base_url="http://localhost:60000"))

# Immediate execution
job_id = await client.send_schedule_request(ScheduleRequest(
    target="https://example.com/webhook",
    method=HttpMethod.POST,
    payload={"key": "value"},
))

# One-time scheduled call
job_id = await client.send_schedule_request(ScheduleRequest(
    target="https://example.com/webhook",
    schedule=OneTimeSchedule(time="2025-12-25T10:00:00Z"),
    payload={"message": "Merry Christmas!"},
))

# Recurring call (every day at midnight)
job_id = await client.send_schedule_request(ScheduleRequest(
    target="https://example.com/cleanup",
    schedule=RecurringSchedule(schedule="0 0 * * *"),
))

# Long-running target — override the per-attempt timeout (seconds, 15–1800).
# On the GCP scheduler this maps to the Cloud Tasks dispatch deadline.
job_id = await client.send_schedule_request(ScheduleRequest(
    target="https://example.com/heavy-job",
    timeout=1500,
))

# Cancel a scheduled job
cancelled = await client.cancel_scheduled_job(job_id)

await client.close()
```

### 2. NotitiaClient

Typed, event-based client with pre-defined event definitions. Use when you have a known set of events with specific payload shapes.

```python
from enum import Enum
from typing import TypedDict
from notitia import (
    NotitiaClient,
    NotitiaClientConfig,
    EventConfig,
    EventDefinitions,
    PreparedEventData,
    HttpMethod,
    OneTimeSchedule,
)


# 1. Define event names
class AppEvent(str, Enum):
    USER_CREATED = "user.created"
    ORDER_PLACED = "order.placed"


# 2. Define argument types
class UserCreatedArgs(TypedDict):
    user_id: str
    email: str


class OrderPlacedArgs(TypedDict):
    order_id: str
    amount: float


# 3. Create prepare functions that transform args into request data
def prepare_user_created(args: UserCreatedArgs) -> PreparedEventData:
    return PreparedEventData(
        payload={"id": args["user_id"], "email": args["email"]},
    )


def prepare_order_placed(args: OrderPlacedArgs) -> PreparedEventData:
    return PreparedEventData(
        payload={"order_id": args["order_id"], "amount": args["amount"]},
        schedule=OneTimeSchedule(time="2025-12-25T10:00:00Z"),  # Optional: schedule the event
    )


# 4. Define the event map
event_definitions: EventDefinitions[AppEvent] = {
    AppEvent.USER_CREATED: EventConfig(
        target="https://example.com/webhook/users",
        method=HttpMethod.POST,
        prepare=prepare_user_created,
    ),
    AppEvent.ORDER_PLACED: EventConfig(
        target="https://example.com/webhook/orders",
        prepare=prepare_order_placed,
    ),
}

# 5. Create the client and emit events
client = NotitiaClient(event_definitions, NotitiaClientConfig(base_url="http://localhost:60000"))

job_id = await client.emit(AppEvent.USER_CREATED, {"user_id": "123", "email": "user@example.com"})
job_id = await client.emit(AppEvent.ORDER_PLACED, {"order_id": "456", "amount": 99.99})

# Cancel a job
await client.cancel(job_id)

# Access the underlying LowLevelClient for ad-hoc requests
await client.client.send_schedule_request(ScheduleRequest(...))

await client.close()
```

### 3. EventsBus

Domain-driven event system with local and scheduled execution, handlers, state tracking, and framework integrations. Use for complex domain event patterns.

```python
from datetime import timedelta
from notitia import NotitiaClient, NotitiaClientConfig
from notitia.events import EventsBus

# Define domain events
class OrderEvents(EventsBus):
    class Event(EventsBus.Event):
        ORDER_PLACED = "order_placed"
        ORDER_REMINDER = "order_reminder"

    @Event.ORDER_PLACED
    async def on_order_placed(self, order_id: str):
        print(f"Order {order_id} placed!")

    @Event.ORDER_REMINDER
    async def on_order_reminder(self, order_id: str):
        print(f"Reminder for order {order_id}")

# Configure once at application startup
client = NotitiaClient({}, NotitiaClientConfig(base_url="http://localhost:60000"))
EventsBus.configure(
    client=client,
    webhook_target="https://your-app.com/notitia/",
)

# Usage
orders = OrderEvents()

# Execute handlers locally (synchronous in current event loop)
await orders.emit_now(OrderEvents.Event.ORDER_PLACED, "order-123")

# Schedule for later execution via Notitia
job_id = await orders.emit_scheduled(
    OrderEvents.Event.ORDER_REMINDER,
    "order-123",
    when=timedelta(hours=24),
)

# Cancel a scheduled event
await orders.cancel_scheduled(OrderEvents.Event.ORDER_REMINDER)
```

See the [EventsBus guide](docs/events-bus.md) for the full API including the `resolve()` pattern, serialization, state tracking, and the `when` parameter options.

## Schedule Types

| Type | Python | Service receives |
|------|--------|-----------------|
| Immediate | Omit `schedule` | Executes ASAP |
| One-time | `OneTimeSchedule(time="2025-12-25T10:00:00Z")` | Executes at specified UTC time |
| Recurring (CRON) | `RecurringSchedule(schedule="0 0 * * *")` | Repeats on CRON schedule |
| Recurring (RRULE) | `RecurringSchedule(schedule="RRULE:FREQ=DAILY;BYHOUR=9")` | Repeats on RRULE schedule |

## Error Handling

All SDK errors are raised as `NotitiaError`:

```python
from notitia import NotitiaError

try:
    job_id = await client.send_schedule_request(request)
except NotitiaError as e:
    print(e.message)        # Human-readable message
    print(e.status)         # HTTP status code (if applicable)
    print(e.response_data)  # Response body from the service
    print(e.cause)          # Underlying exception (if any)
```

429 and 5xx responses are automatically retried before `NotitiaError` is raised. The retry policy is configurable via `RetryConfig` (see **Configuration** above).

## Further Reading

- [EventsBus guide](docs/events-bus.md) — Full documentation for the domain event system
- [Contrib integrations](docs/contrib.md) — FastAPI webhook router, Beanie state tracker
- [Examples](examples/) — Runnable example code
- [Examples walkthrough](../../docs/examples.md) — Annotated guide through the examples
- [Service documentation](../service/README.md) — API reference and deployment guide
