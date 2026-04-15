# Contrib Integrations

The `notitia.contrib` module provides framework-specific adapters for the EventsBus system.

## FastAPI

Provides a webhook router that receives scheduled event callbacks from Notitia and dispatches them to the correct EventsBus handlers.

Install: `pip install notitia[fastapi]`

### Setup

```python
from fastapi import FastAPI
from notitia.contrib.fastapi import create_notitia_router

app = FastAPI()
app.include_router(create_notitia_router())
```

This creates a `POST /notitia/` endpoint that:

1. Receives the `ScheduledEventInvocation` payload from Notitia
2. Locates the correct `EventsBus` subclass via the `event_qualname` field
3. Deserializes the signed payload using the configured serializer
4. Calls `resolve()` if the bus defines it (to reconstruct domain objects)
5. Executes all registered handlers for the event

### Options

```python
router = create_notitia_router(
    path="/notitia",       # URL prefix (default: "/notitia")
    serializer=None,       # Override serializer (default: use EventsBus._serializer)
)
```

### How It Works

When you call `emit_scheduled()`, the EventsBus sends a scheduling request to Notitia with your `webhook_target` as the callback URL. At the scheduled time, Notitia POSTs a `ScheduledEventInvocation` to that URL:

```json
{
  "event_qualname": "myapp.events.UserLifecycle.Event.WELCOME",
  "signed_payload": "...",
  "original_emitter_timestamp_iso": "2025-01-01T00:00:00+00:00",
  "execution_datetime_iso": "2025-01-02T09:30:00+00:00"
}
```

The router parses `event_qualname` to find the `UserLifecycle` class, deserializes the payload, and calls the `@Event.WELCOME` handler(s).

Notitia also sends the `X-Notitia-Task-Id` header, which the router passes to the state tracker for marking events as executed.

### Full Example

```python
from fastapi import FastAPI
from notitia import NotitiaClient, NotitiaClientConfig
from notitia.events import EventsBus
from notitia.contrib.fastapi import create_notitia_router

# Define events
class OrderEvents(EventsBus):
    class Event(EventsBus.Event):
        REMINDER = "reminder"

    @Event.REMINDER
    async def send_reminder(self, order_id: str):
        print(f"Sending reminder for order {order_id}")

# App setup
app = FastAPI()
app.include_router(create_notitia_router())

@app.on_event("startup")
async def startup():
    client = NotitiaClient({}, NotitiaClientConfig(base_url="http://localhost:60000"))
    EventsBus.configure(
        client=client,
        webhook_target="http://localhost:8000/notitia/",
    )
```

## Beanie (MongoDB)

Provides state tracking and document-aware serialization for applications using [Beanie](https://beanie-odm.dev/) as their MongoDB ODM.

Install: `pip install notitia[beanie]`

### BeanieStateTracker

Persists scheduled event state directly on Beanie Document instances. When an event is scheduled, executed, or cancelled, the tracker updates a `scheduled_events` list on the target document.

**Requirements:** Your Document must have a `scheduled_events` field:

```python
from beanie import Document
from notitia.events.event import ScheduledEvent

class User(Document):
    name: str
    email: str
    scheduled_events: list[ScheduledEvent] = []
```

**Setup:**

```python
from notitia.contrib.beanie import BeanieStateTracker

EventsBus.configure(
    client=client,
    webhook_target="https://your-app.com/notitia/",
    state_tracker=BeanieStateTracker(),
)
```

**Behavior:**
- `on_event_scheduled` — appends a `ScheduledEvent` to the document's list (replaces any existing event with the same name)
- `on_event_executed` — sets `executed_on` timestamp (skipped for recurring events, which keep running)
- `on_event_cancelled` — removes the event from the list
- `get_scheduled_event_job_id` — finds the job ID for an active (non-executed) event

### BeanieAwareSerializer

Serializes Beanie Document instances as ID references instead of full objects. On deserialization, documents are fetched from the database by ID.

```python
from notitia.contrib.beanie import BeanieAwareSerializer, register_document_type

@register_document_type
class User(Document):
    name: str
    email: str
    scheduled_events: list[ScheduledEvent] = []
```

The `@register_document_type` decorator is required for each Document type that may appear as an event argument. It enables the serializer to look up and fetch the correct document type during deserialization.

```python
EventsBus.configure(
    client=client,
    webhook_target="https://your-app.com/notitia/",
    serializer=BeanieAwareSerializer(signing_key="your-secret"),  # Optional signing
    state_tracker=BeanieStateTracker(),
)
```

### Full Example with Both

```python
from beanie import Document
from notitia import NotitiaClient, NotitiaClientConfig
from notitia.events import EventsBus
from notitia.events.event import ScheduledEvent
from notitia.contrib.beanie import (
    BeanieStateTracker,
    BeanieAwareSerializer,
    register_document_type,
)

@register_document_type
class User(Document):
    name: str
    email: str
    scheduled_events: list[ScheduledEvent] = []

class UserLifecycle(EventsBus):
    class Event(EventsBus.Event):
        __notitia_queue__ = "lifecycle-user"
        WELCOME = "welcome"
        WEEKLY_DIGEST = "weekly_digest"

    @classmethod
    async def resolve(cls, entity_id: str) -> User:
        return await User.get(entity_id)

    @Event.WELCOME
    async def on_welcome(self, user: User):
        await send_welcome_email(user.email)

    @Event.WEEKLY_DIGEST
    async def on_digest(self, user: User):
        await send_digest(user)

# At startup
client = NotitiaClient({}, NotitiaClientConfig(base_url="http://localhost:60000"))
EventsBus.configure(
    client=client,
    webhook_target="https://your-app.com/notitia/",
    serializer=BeanieAwareSerializer(signing_key="your-secret"),
    state_tracker=BeanieStateTracker(),
)

# Usage
user = await User.get("some-user-id")
lifecycle = UserLifecycle()

# Schedule welcome email for 1 hour from now
# The User document is serialized as just its ID, and resolved back on webhook callback
await lifecycle.emit_scheduled(
    UserLifecycle.Event.WELCOME,
    user,
    when=timedelta(hours=1),
)

# The user's scheduled_events list now contains a ScheduledEvent entry
# Cancel it later:
await lifecycle.cancel_scheduled(UserLifecycle.Event.WELCOME)
```
