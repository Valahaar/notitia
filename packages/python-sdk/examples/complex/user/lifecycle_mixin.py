from __future__ import annotations

import random
from typing import TYPE_CHECKING

import pendulum
from loguru import logger

from ..lifecycle import EventsBus, schedule_business_hours

from .types import Feat

if TYPE_CHECKING:
    from .core import User


class UserLifecycleMixin(EventsBus):
    class Event(EventsBus.Event):
        __notitia_queue__ = "lifecycle-user"

        FIRST_WEEK_CHECK_IN = "first_week_check_in"
        STANDARD_WEEKLY_DIGEST = "standard_weekly_digest"
        UNUSED_FEATURE = "unused_feature"

    @Event.FIRST_WEEK_CHECK_IN
    async def on_first_week_check_in(self: "User"):
        user_id = str(self.id)

        logger.info(f"Sending first weekly digest for user {user_id}")

        now = pendulum.now(self.tz)

        # Schedule weekly digest to run every Monday at 9:30 in the user's timezone.
        # Notitia will handle the recurrence.
        a_week_from_now = now.add(weeks=1)
        first_monday = a_week_from_now.next(pendulum.MONDAY).at(9, 30, 0)

        # we use DTSTART to specify the first execution, and RRULE for the recurrence
        # as per RFC 5545
        dtstart_str = first_monday.format("YYYYMMDDTHHmmss")
        rrule_with_start = (
            f"DTSTART;TZID={self.tz}:{dtstart_str}\n"
            "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30"
        )

        await self.emit_scheduled(
            self.Event.STANDARD_WEEKLY_DIGEST,
            when=rrule_with_start,
        )

        # Schedule unused feature emails
        feature_usage = await self.has_used_features()
        if all(feature_usage.values()):
            logger.info(
                f"{user_id} has used all available features, skipping unused feature emails"
            )
            return

        await self.emit_scheduled(
            self.Event.UNUSED_FEATURE,
            set(),
            when=schedule_business_hours(
                days_offset=random.randint(1, 2),
                user_tz=self.tz,
                weekend_mode="after",
            ),
        )

    @Event.UNUSED_FEATURE
    async def on_unused_feature(self: "User", notifications_received: set[Feat]):
        user_id = str(self.id)

        used_features = await self.has_used_features()
        remaining_notifications = {
            feature
            for feature, used in used_features.items()
            if not used and feature not in notifications_received
        }

        if not remaining_notifications:
            logger.info(f"{user_id} has received all notifications for unused features")
            return

        feature_type_map = {
            Feat.CALENDARS: "calendar",
            Feat.AI_CHAT: "chat",
            Feat.WORKSPACES: "workspace",
        }

        next_notification = next(iter(remaining_notifications))
        feature_type = feature_type_map[next_notification]

        logger.info(f"Sending unused feature reminder ({feature_type}) to user {user_id}")

        notifications_received.add(next_notification)

        # If there are more unused features left, schedule the next reminder.
        if len(remaining_notifications) > 1:
            await self.emit_scheduled(
                self.Event.UNUSED_FEATURE,
                notifications_received,
                when=schedule_business_hours(
                    days_offset=random.randint(1, 2),
                    user_tz=self.tz,
                    weekend_mode="after",
                ),
            )
        else:
            logger.info(
                f"{user_id} has now received all notifications for unused features."
            )

    @Event.STANDARD_WEEKLY_DIGEST
    async def on_weekly_digest(self: "User"):
        if not self.has_active_plan:
            logger.info(f"{self.id} has no active plan, skipping weekly digest")
            return

        # since this is executed on a Monday, we want to get the previous week
        start_of_this_week = pendulum.now(self.tz).start_of("week")
        start_of_last_week = start_of_this_week.subtract(weeks=1)

        logger.info(
            f"Generating weekly digest for user {self.id} "
            f"({start_of_last_week} to {start_of_this_week})"
        )
