import uuid
import datetime

# import sys
# import os
import asyncio
from typing import Dict, Any, List, Literal, TypedDict, overload
from enum import Enum

# Adjust path to import from the parent directory
# sys.path.append(os.path.join(os.path.dirname(__file__), "../src"))

from notitia import (
    NotitiaClient,
    NotitiaClientConfig,
    EventDefinitions,
    EventConfig,
    PreparedEventData,
    HttpMethod,
    ScheduleType,
    ScheduleRequest,
    RecurringSchedule,
    OneTimeSchedule,
    NotitiaError,
)


# --- 0. Define Event Names Enum ---
class AppEvent(str, Enum):
    USER_CREATED = "user.created"
    ORDER_PLACED = "order.placed"
    REPORT_GENERATED = "report.generated"
    MARKETING_CAMPAIGN_SCHEDULED = "marketing.campaignScheduled"
    AD_HOC_LOW_STOCK = "adHoc.py.inventory.lowStock"


# Type alias for our specific EventDefinitions dictionary using AppEvent
AppEventDefinitions = EventDefinitions[AppEvent]


# --- 1. Define Event Argument Types (using TypedDict for clarity) ---
class UserCreatedArgs(TypedDict):
    user_id: str
    email: str
    display_name: str


class OrderPlacedArgs(TypedDict):
    order_id: str
    items: List[
        Dict[str, Any]
    ]  # e.g., [{'product_id': 'prod_aaa', 'quantity': 2, 'price': 10.99}]
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


# --- 2. Define Event Preparation Functions ---
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
        schedule=RecurringSchedule(schedule=schedule_str, type=ScheduleType.RECURRING),
    )


def prepare_marketing_campaign(args: MarketingCampaignArgs) -> PreparedEventData:
    return PreparedEventData(
        payload={
            "campaign_id": args["campaign_id"],
            "target_segment": args["segment_id"],
        },
        schedule=OneTimeSchedule(time=args["scheduled_time"], type=ScheduleType.ON),
    )


# --- 3. Define Event Configurations ---
event_definitions: AppEventDefinitions = {
    AppEvent.USER_CREATED: EventConfig[UserCreatedArgs](
        target="https://webhook.site/YOUR_UNIQUE_ID",  # Replace with your hook
        prepare=prepare_user_created,
    ),
    AppEvent.ORDER_PLACED: EventConfig[OrderPlacedArgs](
        target="https://webhook.site/YOUR_UNIQUE_ID",  # Replace
        method=HttpMethod.PUT,
        prepare=prepare_order_placed,
    ),
    AppEvent.REPORT_GENERATED: EventConfig[ReportGeneratedArgs](
        target="https://webhook.site/YOUR_UNIQUE_ID",  # Replace
        prepare=prepare_report_generated,
    ),
    AppEvent.MARKETING_CAMPAIGN_SCHEDULED: EventConfig[MarketingCampaignArgs](
        target="https://webhook.site/YOUR_UNIQUE_ID",  # Replace
        prepare=prepare_marketing_campaign,
    ),
}

# --- 4. Configure the SDK Client ---
# Ensure this URL is correct for your running notification service
# You might want to use environment variables for sensitive data like API keys or base URLs
# from dotenv import load_dotenv
# load_dotenv()
# base_url = os.getenv("NOTIFICATION_SERVICE_BASE_URL", "http://localhost:60000/api/v1/notifications")
# api_key = os.getenv("NOTIFICATION_SERVICE_API_KEY", "your-service-api-key")

sdk_config = NotitiaClientConfig()


# --- Define the specific client with overloads ---
class TypedNotitiaClient(NotitiaClient[AppEvent]):
    @overload
    async def emit(
        self, event_name: Literal[AppEvent.USER_CREATED], data: UserCreatedArgs
    ) -> None:
        ...

    @overload
    async def emit(
        self, event_name: Literal[AppEvent.ORDER_PLACED], data: OrderPlacedArgs
    ) -> None:
        ...

    @overload
    async def emit(
        self, event_name: Literal[AppEvent.REPORT_GENERATED], data: ReportGeneratedArgs
    ) -> None:
        ...

    @overload
    async def emit(
        self,
        event_name: Literal[AppEvent.MARKETING_CAMPAIGN_SCHEDULED],
        data: MarketingCampaignArgs,
    ) -> None:
        ...

    async def emit(self, event_name: AppEvent, data: Any) -> None:
        await super().emit(event_name, data)


# --- 5. Initialize the Typed Client ---
notification_client = TypedNotitiaClient(event_definitions)


# --- 6. Example Usage: Emitting Events (now async) ---
async def main():
    print("Notification SDK Basic Python Example with Enums and Async")

    try:
        # Example 1: Emit 'user.created'
        print(f"\nEmitting '{AppEvent.USER_CREATED.value}'...")
        user_args: UserCreatedArgs = {
            "user_id": "usr_py_123abc",
            "email": "test.py.user@example.com",
            "display_name": "Test Python User",
        }
        await notification_client.emit(AppEvent.USER_CREATED, user_args)
        await notification_client.emit(
            AppEvent.USER_CREATED.value,
            {"user_id": "id", "email": "email", "display_name": "name"},
        )
        print(f"'{AppEvent.USER_CREATED.value}' event emitted successfully.")

        # Example 2: Emit 'order.placed'
        print(f"\nEmitting '{AppEvent.ORDER_PLACED.value}'...")
        order_args: OrderPlacedArgs = {
            "order_id": "ord_py_456def",
            "items": [
                {"product_id": "prod_py_aaa", "quantity": 2, "price": 10.99},
                {"product_id": "prod_py_bbb", "quantity": 1, "price": 5.49},
            ],
            "customer_email": "customer.py@example.com",
            "send_logistics_notification": True,
        }
        await notification_client.emit(AppEvent.ORDER_PLACED, order_args)
        print(f"'{AppEvent.ORDER_PLACED.value}' event emitted successfully.")

        # Example 3: Emit 'report.generated' (recurring schedule)
        print(f"\nEmitting '{AppEvent.REPORT_GENERATED.value}' (daily)...")
        report_args: ReportGeneratedArgs = {
            "report_id": "rpt_py_daily_789",
            "report_type": "daily_summary",
            "requested_by": "python_cron_job_runner",
        }
        await notification_client.emit(AppEvent.REPORT_GENERATED, report_args)
        print(
            f"'{AppEvent.REPORT_GENERATED.value}' (daily) event emitted successfully."
        )

        # Example 4: Emit 'marketing.campaignScheduled' (one-time schedule)
        one_hour_from_now = (
            datetime.datetime.utcnow() + datetime.timedelta(hours=1)
        ).isoformat() + "Z"
        print(
            f"\nEmitting '{AppEvent.MARKETING_CAMPAIGN_SCHEDULED.value}' for {one_hour_from_now}..."
        )
        campaign_args: MarketingCampaignArgs = {
            "campaign_id": "cmp_py_summer_sale_2024",
            "segment_id": "seg_py_active_users_last_30d",
            "scheduled_time": one_hour_from_now,
        }
        await notification_client.emit(
            AppEvent.MARKETING_CAMPAIGN_SCHEDULED, campaign_args
        )
        print(
            f"'{AppEvent.MARKETING_CAMPAIGN_SCHEDULED.value}' event emitted successfully."
        )

        try:
            print("\nAttempting to emit a non-existent event string...")
            await notification_client.emit("non.existent.event", {})  # type: ignore
        except NotitiaError as e:
            print(f"Caught expected error for non-existent event: {e.message}")

        # Example of using the low-level client for an ad-hoc event
        print("\nEmitting an ad-hoc event using the low-level client...")
        ad_hoc_request = ScheduleRequest(
            event=AppEvent.AD_HOC_LOW_STOCK.value,
            target="https://webhook.site/YOUR_UNIQUE_ID",  # Replace
            payload={
                "productId": "prod_py_xyz789",
                "currentStock": 3,
                "warehouseId": "wh_py_central_1",
            },
            method=HttpMethod.POST,
        )
        await notification_client.client.send_schedule_request(ad_hoc_request)
        print(
            f"Ad-hoc event '{AppEvent.AD_HOC_LOW_STOCK.value}' emitted successfully via low-level client."
        )

    except NotitiaError as e:
        print("\n--- SDK Error ---")
        print(f"Message: {e.message}")
        if e.status:
            print(f"Status: {e.status}")
        if e.response_data:
            print(f"Response Data: {e.response_data}")
        if e.cause:
            print(f"Cause: {e.cause}")
    except Exception as e:
        print("\n--- Unexpected Error ---")
        print(e)
    finally:
        # Important: Close the client when done to release resources
        print("\nClosing HTTP client...")
        await notification_client.close()
        print("HTTP client closed.")


if __name__ == "__main__":
    asyncio.run(main())

"""
To run this example:
1. Replace YOUR_UNIQUE_ID in webhook.site URLs with a unique ID from webhook.site for testing.
2. Make sure you have a Notification Service instance running and accessible at the `base_url`.
3. Install dependencies:
   pip install -r ../requirements.txt
4. Run the script:
   python basic.py (from within the examples folder)
"""
