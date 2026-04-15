import asyncio
import datetime

from notitia import NotitiaError

from .client import notification_client
from .common_event_defs import (
    AppEvent,
    UserCreatedArgs,
    OrderPlacedArgs,
    ReportGeneratedArgs,
    MarketingCampaignArgs,
    TARGET_ENDPOINT,  # For printing info
)


async def main():
    print("--- Typed Client Event Emission Examples ---")
    print(f"All events will target: {TARGET_ENDPOINT}\n")

    job_ids = {}

    try:
        # Example 1: Emit 'user.created.event'
        print(f"Emitting '{AppEvent.USER_CREATED.value}'...")
        user_args: UserCreatedArgs = {
            "user_id": "usr_py_adv_123",
            "email": "advanced.py.user@example.com",
            "display_name": "Advanced Python User",
        }
        job_id_user_created = await notification_client.emit(
            AppEvent.USER_CREATED, user_args
        )
        print(
            f"'{AppEvent.USER_CREATED.value}' event emitted successfully. Job ID: {job_id_user_created}"
        )
        job_ids[AppEvent.USER_CREATED] = job_id_user_created

        # Example 2: Emit 'order.placed.event'
        print(f"\nEmitting '{AppEvent.ORDER_PLACED.value}'...")
        order_args: OrderPlacedArgs = {
            "order_id": "ord_py_adv_456",
            "items": [
                {"product_id": "prod_py_adv_aaa", "quantity": 3, "price": 12.99},
                {"product_id": "prod_py_adv_bbb", "quantity": 1, "price": 8.49},
            ],
            "customer_email": "customer.advanced.py@example.com",
            "send_logistics_notification": False,
        }
        job_id_order_placed = await notification_client.emit(
            AppEvent.ORDER_PLACED, order_args
        )
        print(
            f"'{AppEvent.ORDER_PLACED.value}' event emitted successfully. Job ID: {job_id_order_placed}"
        )
        job_ids[AppEvent.ORDER_PLACED] = job_id_order_placed

        # Example 3: Emit 'report.generated.event' (recurring schedule)
        print(f"\nEmitting '{AppEvent.REPORT_GENERATED.value}' (daily recurring)...")
        report_args: ReportGeneratedArgs = {
            "report_id": "rpt_py_adv_daily_789",
            "report_type": "daily_summary",
            "requested_by": "python_advanced_example_runner",
        }
        job_id_report_generated = await notification_client.emit(
            AppEvent.REPORT_GENERATED, report_args
        )
        print(
            f"'{AppEvent.REPORT_GENERATED.value}' (daily) event emitted. Job ID: {job_id_report_generated}"
        )
        job_ids[AppEvent.REPORT_GENERATED] = job_id_report_generated

        # Example 4: Emit 'marketing.campaignScheduled.event' (one-time schedule)
        # Schedule for a short time in the future to allow for potential cancellation in other examples
        schedule_time = (
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=5)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        print(
            f"\nEmitting '{AppEvent.MARKETING_CAMPAIGN_SCHEDULED.value}' for {schedule_time}..."
        )
        campaign_args: MarketingCampaignArgs = {
            "campaign_id": "cmp_py_adv_q4_promo",
            "segment_id": "seg_py_adv_all_users",
            "scheduled_time": schedule_time,
        }
        job_id_marketing_campaign = await notification_client.emit(
            AppEvent.MARKETING_CAMPAIGN_SCHEDULED, campaign_args
        )
        print(
            f"'{AppEvent.MARKETING_CAMPAIGN_SCHEDULED.value}' event emitted. Job ID: {job_id_marketing_campaign}"
        )
        job_ids[AppEvent.MARKETING_CAMPAIGN_SCHEDULED] = job_id_marketing_campaign

        # Example 5: Attempting to emit an event not fully defined in AppEvent but handled by fallback
        # This assumes ADHOC_LOW_STOCK_ALERT is in AppEvent but not in event_definitions
        # and the TypedNotitiaClient has a fallback overload for `AppEvent`.
        # If ADHOC_LOW_STOCK_ALERT is *not* in event_definitions, this will raise an error as expected.
        print(
            f"\nAttempting to emit '{AppEvent.ADHOC_LOW_STOCK_ALERT.value}' (not in event_definitions)..."
        )
        try:
            # This event is in AppEvent but not in event_definitions in common_event_defs.py
            # So, the client should raise an error before even trying to prepare it.
            adhoc_args = {"product_id": "prod_undefined_event", "stock": 1}
            await notification_client.emit(AppEvent.ADHOC_LOW_STOCK_ALERT, adhoc_args)  # type: ignore
            print(
                f"'{AppEvent.ADHOC_LOW_STOCK_ALERT.value}' emitted (UNEXPECTED for this setup)."
            )
        except NotitiaError as e:
            print(
                f"Caught expected NotitiaError for '{AppEvent.ADHOC_LOW_STOCK_ALERT.value}': {e.message}"
            )
            assert "not defined in the SDK event definitions" in e.message

        # Example 6: Attempting to emit a raw string event (should fail if client expects AppEvent type)
        # The TypedNotitiaClient is typed to accept AppEvent for event_name.
        # Directly passing a string that isn't an AppEvent member would ideally be a type error caught by linters/mypy.
        # If it bypasses static typing and runs, it will fail at runtime in NotitiaClient if the string key isn't in _event_definitions.
        print("\nAttempting to emit a raw string event 'some.random.string.event'...")
        try:
            await notification_client.emit("some.random.string.event", {"data": "test"})  # type: ignore
            print("Raw string event emitted (UNEXPECTED).")
        except NotitiaError as e:
            print(f"Caught expected NotitiaError for raw string event: {e.message}")
            assert (
                "not defined in the SDK event definitions" in e.message
            )  # Or similar error from client
        except TypeError as te:  # Might also be a TypeError if type checking is very strict at runtime somewhere
            print(f"Caught expected TypeError for raw string event: {te}")

    except NotitiaError as e:
        print("\n--- SDK Error during typed client emits ---")
        print(f"Message: {e.message}")
        if e.status:
            print(f"Status: {e.status}")
        if e.response_data:
            print(f"Response Data: {e.response_data}")
        if e.cause:
            print(f"Cause: {e.cause}")
    except Exception as e:
        print("\n--- Unexpected Error during typed client emits ---")
        print(e)
    finally:
        print("\n--- Typed Client Event Emission Examples Complete ---")
        # Note: Client is not closed here as it might be used by other example scripts.
        # A central runner script would handle client setup and teardown.
        # For standalone running, you'd await notification_client.close() here.


if __name__ == "__main__":
    # For standalone running of this script:
    # Ensure you are in the `examples` directory and run as `python -m advanced.run_typed_client_emits`
    # This ensures relative imports work correctly.
    async def run_standalone():
        await main()
        await notification_client.close()  # Close client if script is run standalone
        print("Client closed after standalone run.")

    asyncio.run(run_standalone())
