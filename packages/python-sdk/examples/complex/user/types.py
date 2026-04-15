from enum import Enum
from typing import Literal

from pydantic import BaseModel


class Feat(str, Enum):
    AI_CHAT = "ai_chat"
    CALENDARS = "calendars"
    WORKSPACES = "workspaces"


class UserPlan(BaseModel):
    type: str
    is_active: bool = True
    is_trial: bool = False
    features: list[str] = []
    subscription_id: str | None = None


class ContactInfo(BaseModel):
    type: Literal["email", "mobile"]
    email: str | None = None
    mobile: str | None = None
