from typing import Any, Literal, overload

from notitia import NotitiaClient, NotitiaClientConfig

from .common_event_defs import (
    AppEvent,
    UserCreatedArgs,
    OrderPlacedArgs,
    ReportGeneratedArgs,
    MarketingCampaignArgs,
    event_definitions,
)

sdk_config = NotitiaClientConfig(base_url="http://localhost:60000")


# --- Typed Notitia Client Definition ---
class TypedNotitiaClient(NotitiaClient[AppEvent]):
    @overload
    async def emit(
        self, event_name: Literal[AppEvent.USER_CREATED], data: UserCreatedArgs
    ) -> str:
        ...

    @overload
    async def emit(
        self, event_name: Literal[AppEvent.ORDER_PLACED], data: OrderPlacedArgs
    ) -> str:
        ...

    @overload
    async def emit(
        self, event_name: Literal[AppEvent.REPORT_GENERATED], data: ReportGeneratedArgs
    ) -> str:
        ...

    @overload
    async def emit(
        self,
        event_name: Literal[AppEvent.MARKETING_CAMPAIGN_SCHEDULED],
        data: MarketingCampaignArgs,
    ) -> str:
        ...

    # Fallback for any AppEvent if not specifically overloaded
    # or for AppEvent members not covered by specific overloads.
    @overload
    async def emit(self, event_name: AppEvent, data: Any) -> str:
        ...

    async def emit(self, event_name: AppEvent, data: Any) -> str:
        # The `await super().emit(event_name, data)` will now correctly return a string (jobId)
        # as per the updated NotitiaClient.emit method signature.
        return await super().emit(event_name, data)

# --- Initialize the Typed Client ---
notification_client = TypedNotitiaClient(
    event_definitions=event_definitions, config=sdk_config
)
