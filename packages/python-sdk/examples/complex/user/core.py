"""
Example User model showing how EventsBus integrates with a Beanie (MongoDB) Document.

This is a simplified skeleton — a real application would have full business logic,
but this demonstrates the patterns for combining document persistence with
Notitia's event scheduling and lifecycle management.
"""

from __future__ import annotations

from beanie import Document

from .lifecycle_mixin import UserLifecycleMixin
from .types import ContactInfo, Feat, UserPlan


class User(
    Document,
    UserLifecycleMixin,
):
    identity_provider_id: str | None
    contact_infos: list[ContactInfo]

    first_name: str | None
    last_name: str | None

    plan: UserPlan | None = None
    tz: str | None = "Europe/Rome"
    organization: str | None = None
    enabled: bool = True

    @property
    def has_active_plan(self):
        return self.plan is not None and self.plan.is_active

    @property
    def main_email(self):
        for contact_info in self.contact_infos:
            if contact_info.email:
                return contact_info.email
        raise ValueError("No email contact info found")

    @property
    def name(self):
        return f"{self.first_name} {self.last_name}"

    async def has_used_features(self) -> dict[Feat, bool]:
        """Check which features the user has actually used.
        In a real app, this would query usage data."""
        return {feat: False for feat in Feat}

    def has_feature(self, feature: Feat) -> bool:
        return self.has_active_plan and feature.value in (self.plan.features or [])

    class Settings:
        name = "users"
