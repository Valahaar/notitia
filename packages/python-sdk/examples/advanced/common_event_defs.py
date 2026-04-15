import datetime
import uuid
from enum import Enum
from typing import Any, Dict, List, TypedDict

from notitia import (
    EventConfig,
    EventDefinitions,
    HttpMethod,
    OneTimeSchedule,
    PreparedEventData,
    RecurringSchedule,
)


# --- 0. Define Event Names Enum ---
class AppEvent(str, Enum):
    USER_CREATED = "user.created.event"  # Added .event suffix for clarity
    ORDER_PLACED = "order.placed.event"
    REPORT_GENERATED = "report.generated.event"
    MARKETING_CAMPAIGN_SCHEDULED = "marketing.campaignScheduled.event"
    ADHOC_LOW_STOCK_ALERT = "adhoc.inventory.lowStock.py.event"


# Type alias for our specific EventDefinitions dictionary using AppEvent
AppEventDefinitions = EventDefinitions[AppEvent]


# --- 1. Define Event Argument Types (using TypedDict for clarity) ---
class UserCreatedArgs(TypedDict):
    user_id: str
    email: str
    display_name: str


class OrderPlacedArgs(TypedDict):
    order_id: str
    items: List[Dict[str, Any]]
    customer_email: str
    send_logistics_notification: bool


class ReportGeneratedArgs(TypedDict):
    report_id: str
    report_type: str  # 'daily_summary' | 'weekly_detail'
    requested_by: str


class MarketingCampaignArgs(TypedDict):
    campaign_id: str
    segment_id: str
    scheduled_time: str  # ISO string for one-time schedule


TARGET_ENDPOINT = "http://192.168.14.42:3000"


def prepare_user_created(args: UserCreatedArgs) -> PreparedEventData:
    return PreparedEventData(
        payload={
            "id": args["user_id"],
            "email": args["email"],
            "name": args["display_name"],
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat() + "Z",
        }
    )


def prepare_order_placed(args: OrderPlacedArgs) -> PreparedEventData:
    total_amount = sum(item["price"] * item["quantity"] for item in args["items"])
    return PreparedEventData(
        payload={
            "orderId": args["order_id"],
            "customer": args["customer_email"],
            "lineItems": args["items"],
            "totalAmount": total_amount,
        },
        headers={"X-Correlation-ID": str(uuid.uuid4()), "X-Shop-Domain": "my-shop.com"},
        params={"notifyLogistics": str(args["send_logistics_notification"]).lower()},
    )


def prepare_report_generated(args: ReportGeneratedArgs) -> PreparedEventData:
    schedule_str = (
        "0 1 * * *" if args["report_type"] == "daily_summary" else "0 2 * * 1"
    )  # Daily @ 1AM or Weekly Mon @ 2AM
    return PreparedEventData(
        payload={
            "id": args["report_id"],
            "type": args["report_type"],
            "generatedBy": args["requested_by"],
            "status": "PENDING_GENERATION",
        },
        schedule=RecurringSchedule(schedule=schedule_str),  # type is inferred
    )


def prepare_marketing_campaign(args: MarketingCampaignArgs) -> PreparedEventData:
    return PreparedEventData(
        payload={
            "campaign_id": args["campaign_id"],
            "target_segment": args["segment_id"],
        },
        schedule=OneTimeSchedule(time=args["scheduled_time"]),  # type is inferred
    )


# --- 3. Define Event Configurations ---
event_definitions: AppEventDefinitions = {
    AppEvent.USER_CREATED: EventConfig[UserCreatedArgs](
        target=TARGET_ENDPOINT,
        prepare=prepare_user_created,
    ),
    AppEvent.ORDER_PLACED: EventConfig[OrderPlacedArgs](
        target=TARGET_ENDPOINT,
        method=HttpMethod.PUT,
        prepare=prepare_order_placed,
    ),
    AppEvent.REPORT_GENERATED: EventConfig[ReportGeneratedArgs](
        target=TARGET_ENDPOINT,
        prepare=prepare_report_generated,
    ),
    AppEvent.MARKETING_CAMPAIGN_SCHEDULED: EventConfig[MarketingCampaignArgs](
        target=TARGET_ENDPOINT,
        prepare=prepare_marketing_campaign,
    ),
}
