from datetime import datetime, timedelta, timezone
from typing import Literal, Union

import pendulum

WhenType = Union[
    Literal["now"],  # Execute via Notitia immediately
    datetime,  # Specific datetime
    timedelta,  # Relative to now
    pendulum.DateTime,  # Pendulum datetime
    int,  # Unix timestamp
    str,  # recurrence rule (RRULE or cron)
]

ExecutionStrategy = Union[None, datetime, str]


class SchedulingResolver:
    """Resolves various 'when' formats to execution strategy"""

    @staticmethod
    def resolve(when: WhenType) -> ExecutionStrategy:
        """
        Returns execution strategy:
        - None: Execute immediately without Notitia
        - datetime: Execute via Notitia at specified time
        - str: recurrence rule (RRULE or cron)
        """

        if when == "now":
            # though I don't really like this, it's the only way to ensure
            # that we have enough time to save the scheduled event in the DB
            # before the event is executed (otherwise then we can't update its execution time)
            return SchedulingResolver.resolve(timedelta(seconds=1))

        if isinstance(when, (str, datetime)):
            return when

        if isinstance(when, timedelta):
            return datetime.now(timezone.utc) + when

        if isinstance(when, pendulum.DateTime):
            return when.in_timezone("UTC")

        if isinstance(when, int):
            return datetime.fromtimestamp(when)

        raise ValueError(f"Unsupported 'when' type: {type(when)}")


def schedule_business_hours(
    *,
    user_tz: str = "Europe/Rome",
    days_offset: int = 0,
    hour: int = 9,
    minute: int = 30,
    weekend_mode: Literal["before", "after", "ignore"] = "before",
    start_date: datetime | pendulum.DateTime | None = None,
) -> datetime:
    """
    Unified scheduling function that handles timezone-aware business hour scheduling.

    Args:
        user_tz: User's timezone (defaults to Europe/Rome)
        days_offset: Number of days to add to the calculated date
        hour: Hour of the day (24-hour format, default 9 AM)
        minute: Minute of the hour (default 30)
        weekend_mode: How to handle weekends:
            - "before": Move weekend dates to the previous Friday
            - "after": Move weekend dates to the following Monday
            - "ignore": Keep weekend dates as they are
        start_date: Start date to use for scheduling (defaults to now)
    Returns:
        datetime: Scheduled datetime in the user's timezone
    """
    now_in_user_tz = (
        pendulum.instance(start_date)
        if start_date is not None
        else pendulum.now(user_tz)
    )
    scheduled_date = now_in_user_tz.add(days=days_offset)

    # Handle weekends based on the specified mode
    if (
        weekend_mode != "ignore" and scheduled_date.weekday() >= 5
    ):  # Weekend (Saturday=5, Sunday=6)
        if weekend_mode == "after":
            # Move to next Monday (Monday=0)
            days_to_add = 7 - scheduled_date.weekday()  # 2 for Saturday, 1 for Sunday
            scheduled_date = scheduled_date.add(days=days_to_add)
        elif weekend_mode == "before":
            # Move to previous Friday (Friday=4)
            days_to_subtract = (
                scheduled_date.weekday() - 4
            )  # 1 for Saturday, 2 for Sunday
            scheduled_date = scheduled_date.subtract(days=days_to_subtract)

    # Set the specific time
    scheduled_time = scheduled_date.set(
        hour=hour, minute=minute, second=0, microsecond=0
    )

    return scheduled_time
