from datetime import datetime, timedelta, timezone
from typing import Literal, Union

WhenType = Union[
    Literal["now"],
    datetime,
    timedelta,
    int,
    str,
]
"""Flexible schedule specification.

- ``"now"`` — dispatch via Notitia immediately (1-second delay for DB save)
- ``datetime`` — execute at a specific UTC datetime
- ``timedelta`` — execute relative to now
- ``int`` — Unix timestamp
- ``str`` — recurrence rule (RRULE or CRON)
"""


class SchedulingResolver:
    """Resolves a ``WhenType`` value into an execution strategy.

    Returns:
        ``datetime`` for one-time execution, ``str`` for recurrence rules.
    """

    @staticmethod
    def resolve(when: WhenType) -> datetime | str:
        if when == "now":
            return SchedulingResolver.resolve(timedelta(seconds=1))

        if isinstance(when, str):
            return when

        if isinstance(when, datetime):
            return when

        if isinstance(when, timedelta):
            return datetime.now(timezone.utc) + when

        if isinstance(when, int):
            return datetime.fromtimestamp(when, tz=timezone.utc)

        # Try pendulum.DateTime if available
        try:
            import pendulum

            if isinstance(when, pendulum.DateTime):
                return when.in_timezone("UTC")
        except ImportError:
            pass

        raise ValueError(f"Unsupported 'when' type: {type(when)}")


def schedule_business_hours(
    *,
    user_tz: str = "Europe/Rome",
    days_offset: int = 0,
    hour: int = 9,
    minute: int = 30,
    weekend_mode: Literal["before", "after", "ignore"] = "before",
    start_date: Union[datetime, None] = None,
) -> datetime:
    """Schedule at a business-hour time in the user's timezone.

    Requires ``pendulum`` (install with ``pip install notitia[pendulum]``).

    Args:
        user_tz: IANA timezone string.
        days_offset: Days to add from start_date (or now).
        hour: Hour in 24h format.
        minute: Minute of the hour.
        weekend_mode: ``"before"`` moves to Friday, ``"after"`` to Monday,
            ``"ignore"`` keeps weekends.
        start_date: Base date (defaults to now in user_tz).
    """
    try:
        import pendulum
    except ImportError:
        raise ImportError(
            "schedule_business_hours requires pendulum. "
            "Install it with: pip install notitia[pendulum]"
        )

    now_in_user_tz = (
        pendulum.instance(start_date) if start_date is not None else pendulum.now(user_tz)
    )
    scheduled_date = now_in_user_tz.add(days=days_offset)

    if weekend_mode != "ignore" and scheduled_date.weekday() >= 5:
        if weekend_mode == "after":
            days_to_add = 7 - scheduled_date.weekday()
            scheduled_date = scheduled_date.add(days=days_to_add)
        elif weekend_mode == "before":
            days_to_subtract = scheduled_date.weekday() - 4
            scheduled_date = scheduled_date.subtract(days=days_to_subtract)

    scheduled_time = scheduled_date.set(hour=hour, minute=minute, second=0, microsecond=0)
    return scheduled_time
