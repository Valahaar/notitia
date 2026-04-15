from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Dict, Any, Union


class ScheduleType(str, Enum):
    ON = "on"
    RECURRING = "recurring"


class HttpMethod(str, Enum):
    POST = "POST"
    GET = "GET"
    PUT = "PUT"
    DELETE = "DELETE"
    PATCH = "PATCH"


@dataclass
class ScheduleBase:
    type: ScheduleType


@dataclass
class OneTimeSchedule(ScheduleBase):
    time: str  # ISO 8601 datetime string in UTC
    type: ScheduleType = field(default=ScheduleType.ON, init=False)


@dataclass
class RecurringSchedule(ScheduleBase):
    schedule: str  # CRON string or RRule string
    type: ScheduleType = field(default=ScheduleType.RECURRING, init=False)


# Union type for schedule parameter in EmitRequestDto
Schedule = Union[OneTimeSchedule, RecurringSchedule]


@dataclass
class ScheduleRequest:
    target: str
    queue: Optional[str] = None
    schedule: Optional[Schedule] = None
    method: Optional[HttpMethod] = None
    payload: Optional[Dict[str, Any]] = None
    headers: Optional[Dict[str, str]] = None
    params: Optional[Dict[str, str]] = None
