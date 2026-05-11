from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Generic, Optional, TypeVar

from .common_types import (
    HttpMethod,
    Schedule,
)
from .retry import RetryConfig

PA = TypeVar("PA")
EventNameT = TypeVar("EventNameT", bound=str)


@dataclass
class NotitiaClientConfig:
    """Configuration for the Notification SDK client."""

    """Base URL of the Notification Service API (e.g., "http://localhost:3000")"""
    base_url: str = "http://localhost:60000"

    timeout: Optional[float] = 10.0

    """Optional default headers to be sent with every request."""
    default_headers: Optional[Dict[str, str]] = None

    """Optional default queue to be used for the client."""
    default_queue: Optional[str] = None

    """Retry policy for 429 / 5xx responses. Defaults to RetryConfig()."""
    retry: RetryConfig = field(default_factory=RetryConfig)


@dataclass
class PreparedEventData:
    """
    Describes the data that an event's `prepare` function should return.
    This data will be used to construct the final EmitRequestDto.
    """

    payload: Optional[Dict[str, Any]] = None
    headers: Optional[Dict[str, str]] = None
    params: Optional[Dict[str, str]] = None
    schedule: Optional[Schedule] = None
    """Optional HTTP method to override the event's default or client's default."""
    method: Optional[HttpMethod] = None
    """Optional target to override the event's default or client's default."""
    target: Optional[str] = None
    queue: Optional[str] = None
    """Optional per-call timeout in seconds (15–1800). Maps to the Cloud Tasks dispatch deadline on the GCP scheduler."""
    timeout: Optional[int] = None

# For TArgs, using List[Any] or a TypeVar for more specific argument types if needed.
# Callable[..., PreparedEventData] means any number of args, any type of args.
# If we want to type args like in TS, we'd need more complex generics or users define
# a Protocol for their prepare functions.
# For simplicity now, Callable[..., PreparedEventData] is flexible.
@dataclass
class EventConfig(Generic[PA]):
    """Configuration for a single pre-defined event."""

    """
    A function that takes a specific argument of type PA and returns the data
    (payload, headers, params, schedule, method override) for the event emission.
    """
    prepare: Callable[[PA], PreparedEventData]
    """The target URL for this event. Can be overridden by `prepare` function."""
    target: Optional[str] = None
    """Default HTTP method for this event (e.g., POST). Can be overridden by `prepare` function."""
    method: Optional[HttpMethod] = None


# Type alias for a map of event names to their configurations.
# It's generic over EventNameT, and the EventConfig can take Any for its PA type
# when stored in the dictionary, as different events will have different PA types.
EventDefinitions = Dict[EventNameT, EventConfig[Any]]
