# Examples Walkthrough

This guide walks through the example code in [`packages/python-sdk/examples/`](../packages/python-sdk/examples/). Each example builds on the previous one, progressing from basic SDK usage to a production-like domain event system.

## Prerequisites

- A running Notitia service (in-memory mode is fine for testing):
  ```bash
  docker compose up service-in-memory
  ```
- The SDK installed: `pip install notitia` (or `pip install -e ".[all]"` from the SDK directory)
- For webhook testing, [webhook.site](https://webhook.site) provides a free endpoint to inspect incoming requests

## Basic Example

**File:** [`examples/basic.py`](../packages/python-sdk/examples/basic.py)

This example demonstrates the complete NotitiaClient workflow:

### 1. Define Events as Enums

```python
class AppEvent(str, Enum):
    USER_CREATED = "user.created"
    ORDER_PLACED = "order.placed"
    REPORT_GENERATED = "report.generated"
    MARKETING_CAMPAIGN_SCHEDULED = "marketing.campaignScheduled"
```

### 2. Define Typed Arguments

Each event has a `TypedDict` describing its expected arguments:

```python
class UserCreatedArgs(TypedDict):
    user_id: str
    email: str
    display_name: str
```

### 3. Write Prepare Functions

Prepare functions transform domain-specific arguments into HTTP request data. This is where you map your application's data model to the webhook payload:

```python
def prepare_order_placed(args: OrderPlacedArgs) -> PreparedEventData:
    total = sum(item["price"] * item["quantity"] for item in args["items"])
    return PreparedEventData(
        payload={"orderId": args["order_id"], "totalAmount": total},
        headers={"X-Correlation-ID": str(uuid.uuid4())},
        params={"notifyLogistics": str(args["send_logistics_notification"]).lower()},
    )
```

The prepare function can also set a schedule, letting event-specific logic determine when the call happens:

```python
def prepare_report_generated(args: ReportGeneratedArgs) -> PreparedEventData:
    schedule_str = "0 1 * * *" if args["report_type"] == "daily_summary" else "0 2 * * 1"
    return PreparedEventData(
        payload={...},
        schedule=RecurringSchedule(schedule=schedule_str),
    )
```

### 4. Type-Safe Client with Overloads

The example shows how to create a typed client using Python `@overload` decorators, so your IDE knows exactly which argument type each event expects:

```python
class TypedNotitiaClient(NotitiaClient[AppEvent]):
    @overload
    async def emit(self, event_name: Literal[AppEvent.USER_CREATED], data: UserCreatedArgs) -> str: ...
    @overload
    async def emit(self, event_name: Literal[AppEvent.ORDER_PLACED], data: OrderPlacedArgs) -> str: ...

    async def emit(self, event_name: AppEvent, data: Any) -> str:
        return await super().emit(event_name, data)
```

### 5. Error Handling

The example shows how undefined events raise `NotitiaError`:

```python
try:
    await client.emit("non.existent.event", {})
except NotitiaError as e:
    print(e.message)  # 'Event "non.existent.event" is not defined...'
```

### 6. Low-Level Fallback

For one-off requests that don't fit a pre-defined event, use the underlying `LowLevelClient`:

```python
await client.client.send_schedule_request(ScheduleRequest(
    target="https://example.com/webhook",
    payload={"productId": "xyz", "currentStock": 3},
))
```

## Advanced Examples

**Directory:** [`examples/advanced/`](../packages/python-sdk/examples/advanced/)

This example splits the code into modules for a more realistic project structure.

### Module Structure

| File | Purpose |
|------|---------|
| `common_event_defs.py` | Event enum, TypedDicts, prepare functions, EventDefinitions map |
| `client.py` | Client instantiation with typed overloads |
| `run_typed_client_emits.py` | Emitting pre-defined events |
| `run_scheduling_and_cancellation.py` | Scheduling and cancellation lifecycle |

### Scheduling and Cancellation Flow

[`run_scheduling_and_cancellation.py`](../packages/python-sdk/examples/advanced/run_scheduling_and_cancellation.py) demonstrates the full job lifecycle:

1. **Schedule a one-time event** — returns a `job_id`
2. **Schedule a recurring event** — also returns a `job_id`
3. **Schedule via the low-level client** — ad-hoc request with `ScheduleRequest`
4. **Cancel all scheduled jobs** — using `client.cancel(job_id)`
5. **Edge cases**:
   - Cancelling an already-cancelled job (succeeds idempotently)
   - Cancelling a non-existent job (raises `NotitiaError` with 404)
   - Cancelling an immediate job after it has already executed

## Complex / Lifecycle Example

**Directory:** [`examples/complex/`](../packages/python-sdk/examples/complex/)

This is a production-like example showing the full EventsBus pattern integrated with a domain model. It represents how Notitia is used in a real application.

### Architecture

```
examples/complex/
├── lifecycle/
│   ├── bus.py           # EventsBus base + configure()
│   ├── event.py         # ScheduledEventInvocation import
│   ├── notitia.py       # NotitiaClient wrapper
│   ├── scheduling.py    # SchedulingResolver + schedule_business_hours
│   └── serialization.py # Custom serializer (JWT + jsonpickle)
├── user/
│   ├── core.py          # User Document (Beanie)
│   └── lifecycle_mixin.py  # UserLifecycleMixin (EventsBus subclass)
└── notitia_router.py    # FastAPI webhook router
```

### Key Patterns

**Domain Event Chaining** — The `on_first_week_check_in` handler schedules the next event (`STANDARD_WEEKLY_DIGEST`) after completing its work. This creates a chain: user signup triggers the first check-in, which then sets up recurring weekly digests.

**DTSTART + RRULE for Timezone-Aware Recurrence** — Instead of a simple CRON string, the example uses RFC 5545 compliant DTSTART with RRULE to specify both when the recurrence starts and the schedule:

```python
dtstart_str = first_monday.format("YYYYMMDDTHHmmss")
rrule_with_start = (
    f"DTSTART;TZID={self.tz}:{dtstart_str}\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30"
)
await self.emit_scheduled(self.Event.STANDARD_WEEKLY_DIGEST, when=rrule_with_start)
```

**Progressive Feature Adoption Emails** — The `on_unused_feature` handler checks which features the user hasn't tried, sends a reminder for one, then reschedules itself for the next unused feature. It terminates naturally when all features have been covered.

**Business Hours Scheduling** — Uses `schedule_business_hours()` with randomized offsets and weekend handling:

```python
await self.emit_scheduled(
    self.Event.UNUSED_FEATURE,
    notifications_sent,
    when=schedule_business_hours(
        days_offset=random.randint(1, 2),
        user_tz=self.tz,
        weekend_mode="after",  # Push to Monday if it lands on weekend
    ),
)
```

**Mixin Pattern** — The `UserLifecycleMixin` is an EventsBus subclass that gets mixed into the `User` Document class. This keeps lifecycle event logic separate from the core model while allowing handlers to access user data via `self`.
