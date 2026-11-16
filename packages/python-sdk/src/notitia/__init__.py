# Export core classes
from .typed_client import NotitiaClient
from .low_level_client import LowLevelClient, NotitiaError

# Export DTOs and Enums from common_types
from .common_types import (
    ScheduleType,
    HttpMethod,
    ScheduleBase,
    OneTimeSchedule,
    RecurringSchedule,
    Schedule,  # Union type
    ScheduleRequest,
    NOTITIA_TASK_ID_HEADER,
    NOTITIA_OCCURRENCE_HEADER,
)

# Export configuration and event definition types
from .types import (
    NotitiaClientConfig,
    PreparedEventData,
    EventConfig,
    EventDefinitions,
)

# Export retry configuration
from .retry import RetryConfig

__all__ = [
    "NotitiaClient",
    "LowLevelClient",
    "NotitiaError",
    "ScheduleType",
    "HttpMethod",
    "ScheduleBase",
    "OneTimeSchedule",
    "RecurringSchedule",
    "Schedule",
    "ScheduleRequest",
    "NOTITIA_TASK_ID_HEADER",
    "NOTITIA_OCCURRENCE_HEADER",
    "NotitiaClientConfig",
    "PreparedEventData",
    "EventConfig",
    "EventDefinitions",
    "RetryConfig",
    "events",
]
