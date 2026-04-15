---
description: EventsBus — framework-agnostic event system with decorator-based handlers, pluggable serialization, and state tracking
---

# Subsystem: Events Bus

## Purpose

Provides a high-level event-driven programming model on top of Notitia scheduling. Users define domain events as Enum members, decorate async methods as handlers, and emit events either locally or scheduled for deferred execution via the Notitia service.

## Architecture

Three layers:

1. **Core** (`notitia.events`) — zero extra deps beyond httpx
2. **FastAPI adapter** (`notitia.contrib.fastapi`) — webhook router for receiving callbacks
3. **Beanie adapter** (`notitia.contrib.beanie`) — Document state tracking + document-aware serialization

## Core Abstractions

- **`EventsBus`** (`events/bus.py`) — Base class. Subclass to define domain events. Provides `emit_now()`, `emit_scheduled()`, `cancel_scheduled()`, and `configure()`.
- **`Event`** (`events/event.py`) — `str, Enum` base with `__notitia_queue__` class var. Members are callable as decorators for handler registration.
- **`ScheduledEventInvocation`** (`events/event.py`) — Dataclass payload sent through Notitia and delivered to the webhook endpoint.
- **`EventSerializer`** (`events/serialization.py`) — Protocol for arg serialization. Default `JsonSerializer` uses stdlib json + optional HMAC-SHA256.
- **`StateTracker`** (`events/state.py`) — Protocol for tracking scheduled event lifecycle. Default `NoOpStateTracker` does nothing.
- **`SchedulingResolver`** (`events/scheduling.py`) — Converts `WhenType` (datetime, timedelta, int, str, "now") to execution strategy.

## Handler Registration

Uses `__init_subclass__` to discover methods decorated with `@Event.MEMBER`. Handlers stored in `_handlers: ClassVar[dict[Type, dict[Event, list[Callable]]]]`.

Alternative: `@MyBus.on(MyBus.Event.MEMBER)` for external handler registration.

## Self-Resolution Pattern

For domain objects that need to be reconstructed on the webhook side:

1. Override `resolve(cls, entity_id) -> obj` on the EventsBus subclass
2. `emit_scheduled` detects `resolve` is overridden and serializes `self` as `self.id`
3. The FastAPI adapter calls `resolve()` to reconstruct the object before invoking handlers

For full-power serialization (arbitrary Python objects), use a custom `EventSerializer` like `BeanieAwareSerializer`.

## Data Flow (Scheduled Event)

1. `bus.emit_scheduled(event, *args, when=...)` called
2. Args serialized via `EventSerializer.serialize()`
3. `SchedulingResolver.resolve(when)` → datetime or RRULE string
4. `ScheduledEventInvocation` built with event qualname + signed payload
5. Emitted via `NotitiaClient.emit("_notitia_bus_event", invocation)` using existing `EventConfig`/`prepare()` flow
6. Notitia service schedules the HTTP call
7. At execution time, Notitia POSTs to webhook endpoint
8. FastAPI adapter deserializes, resolves class + event, calls `_execute_locally()`
9. Handlers invoked, state tracker updated

## Contrib: FastAPI Adapter

`create_notitia_router(path, serializer)` → `APIRouter` with POST endpoint that:
- Parses `event_qualname` to dynamically locate EventsBus subclass + Event member
- Deserializes signed payload
- Calls `resolve()` if defined
- Invokes `_execute_locally()` with `x_notitia_task_id` header

## Contrib: Beanie Adapter

- **`BeanieStateTracker`** — Persists `scheduled_events` list on Document instances via `$set` updates
- **`BeanieAwareSerializer`** — Serializes Document instances as `{__beanie_doc__: qualname, id: str}`, fetches from DB on deserialize
- **`register_document_type(cls)`** — Decorator to register Document subclasses for deserialization

## Invariants

- `EventsBus.configure()` must be called exactly once at startup
- Core events module has zero dependencies beyond httpx (stdlib only)
- Framework imports (fastapi, beanie) are deferred to runtime in contrib modules
- `_notitia_bus_event` is the internal event name registered with `NotitiaClient`

## Related Files

| File | Role |
|------|------|
| `src/notitia/events/__init__.py` | Public API exports |
| `src/notitia/events/bus.py` | EventsBus core class |
| `src/notitia/events/event.py` | Event enum, ScheduledEventInvocation, ScheduledEvent |
| `src/notitia/events/serialization.py` | EventSerializer protocol, JsonSerializer |
| `src/notitia/events/state.py` | StateTracker protocol, NoOpStateTracker |
| `src/notitia/events/scheduling.py` | SchedulingResolver, WhenType, schedule_business_hours |
| `src/notitia/contrib/fastapi.py` | FastAPI webhook router factory |
| `src/notitia/contrib/beanie.py` | BeanieStateTracker, BeanieAwareSerializer |
| `examples/complex/` | Reference integration (the original production pattern) |
