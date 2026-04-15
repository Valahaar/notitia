import asyncio
import datetime
import uuid

from notitia import (
    NotitiaError,
    ScheduleRequest,
    OneTimeSchedule,
    HttpMethod,
)

from .client import notification_client
from .common_event_defs import (
    AppEvent,
    MarketingCampaignArgs,
    ReportGeneratedArgs,
    UserCreatedArgs,
    TARGET_ENDPOINT,
)


async def main():
    print("--- Scheduling and Cancellation Examples ---")
    print(f"All scheduled events will target: {TARGET_ENDPOINT}\n")

    # To store job IDs for later cancellation
    job_ids_to_cancel = []

    try:
        # --- Typed Client: One-Time Schedule and Cancel ---
        print("\n=== Typed Client: One-Time Scheduling and Cancellation ===")
        one_time_schedule_time = (
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=2)  # Give some time before it executes
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        campaign_args: MarketingCampaignArgs = {
            "campaign_id": f"cmp_py_onetimetocancel_{uuid.uuid4().hex[:8]}",
            "segment_id": "seg_py_adv_cancellation_test",
            "scheduled_time": one_time_schedule_time,
        }
        print(
            f"Scheduling one-time event '{AppEvent.MARKETING_CAMPAIGN_SCHEDULED.value}' for {one_time_schedule_time}..."
        )
        job_id_one_time = await notification_client.emit(
            AppEvent.MARKETING_CAMPAIGN_SCHEDULED, campaign_args
        )
        print(f"One-time event scheduled. Job ID: {job_id_one_time}")
        job_ids_to_cancel.append(job_id_one_time)

        # --- Typed Client: Recurring Schedule and Cancel ---
        print("\n=== Typed Client: Recurring Scheduling and Cancellation ===")
        report_args: ReportGeneratedArgs = {
            "report_id": f"rpt_py_recurringtocancel_{uuid.uuid4().hex[:8]}",
            "report_type": "daily_summary",  # Will use cron "0 1 * * *"
            "requested_by": "py_adv_cancel_example_runner",
        }
        print(f"Scheduling recurring event '{AppEvent.REPORT_GENERATED.value}'...")
        job_id_recurring = await notification_client.emit(
            AppEvent.REPORT_GENERATED, report_args
        )
        print(f"Recurring event scheduled. Job ID: {job_id_recurring}")
        job_ids_to_cancel.append(job_id_recurring)

        # --- Low-Level Client: Ad-hoc Schedule and Cancel ---
        print("\n=== Low-Level Client: Ad-hoc Scheduling and Cancellation ===")
        adhoc_target_url = f"{TARGET_ENDPOINT}/lowlevel/{uuid.uuid4().hex[:8]}"
        adhoc_schedule_time = (
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=15)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        adhoc_request = ScheduleRequest(
            target=adhoc_target_url,
            method=HttpMethod.POST,
            payload={"data": "low-level adhoc data", "id": uuid.uuid4().hex},
            schedule=OneTimeSchedule(time=adhoc_schedule_time),
            headers={"X-Source": "python-sdk-lowlevel-example"},
        )
        print(
            f"Scheduling ad-hoc one-time job to {adhoc_target_url} for {adhoc_schedule_time} via low-level client..."
        )
        job_id_low_level = await notification_client.client.send_schedule_request(
            adhoc_request
        )
        print(f"Ad-hoc job scheduled via low-level client. Job ID: {job_id_low_level}")
        job_ids_to_cancel.append(job_id_low_level)

        # --- Perform Cancellations ---
        print("\n\n--- Attempting Cancellations ---")
        await asyncio.sleep(2)  # Small delay before trying to cancel

        for job_id in job_ids_to_cancel:
            print(
                f"\nAttempting to cancel job ID: {job_id} using typed client's cancel..."
            )
            try:
                success = await notification_client.cancel(job_id)
                if success:
                    print(
                        f"Successfully cancelled job ID: {job_id} (or it was already processed/gone)."
                    )
                else:
                    print(
                        f"Failed to cancel job ID: {job_id} (server indicated failure, e.g. if it never existed and API returns false)."
                    )
            except NotitiaError as e:
                print(
                    f"SDK Error trying to cancel job ID {job_id}: {e.message} (Status: {e.status}, Data: {e.response_data})"
                )
            except Exception as e:
                print(f"Unexpected error cancelling job {job_id}: {e}")

        # --- Additional Cancellation Scenarios ---
        print("\n\n--- Additional Cancellation Scenarios ---")

        # 1. Try to cancel a job that was (presumably) just cancelled
        if job_ids_to_cancel:
            already_cancelled_job_id = job_ids_to_cancel[0]
            print(
                f"\nAttempting to cancel an already cancelled job ID: {already_cancelled_job_id} again..."
            )
            try:
                success = await notification_client.cancel(already_cancelled_job_id)
                print(
                    f"Cancellation attempt for {already_cancelled_job_id} (already cancelled): {success} (expected true as per API doc)"
                )
            except NotitiaError as e:
                print(
                    f"SDK Error re-cancelling job {already_cancelled_job_id}: {e.message}"
                )

        # 2. Try to cancel a completely non-existent job ID
        non_existent_job_id = f"job_py_non_existent_{uuid.uuid4().hex}"
        print(f"\nAttempting to cancel a non-existent job ID: {non_existent_job_id}...")
        try:
            success = await notification_client.cancel(non_existent_job_id)
            print(
                f"Cancellation attempt for non-existent job {non_existent_job_id}: {success} (expected true as per API doc)"
            )
        except NotitiaError as e:
            # This behavior might depend on server: 404 could be an error or handled gracefully as 'true' by the SDK wrapper.
            # The current low_level_client raises NotitiaError for 404, but cancel in typed_client might evolve.
            print(
                f"SDK Error cancelling non-existent job {non_existent_job_id}: {e.message} (Status: {e.status})"
            )

        # 3. Schedule a job very soon and try to cancel it *after* it might have run
        # Note: This is timing-dependent and not a reliable test for "ran then cancelled"
        print(
            "\nAttempting to schedule a job for immediate execution and then cancel..."
        )
        quick_job_args: UserCreatedArgs = {
            "user_id": f"usr_py_quick_{uuid.uuid4().hex[:4]}",
            "email": "quick.fire@example.com",
            "display_name": "Quick Fire User",
        }
        # No schedule = immediate execution
        quick_job_id = await notification_client.emit(
            AppEvent.USER_CREATED, quick_job_args
        )
        print(f"Scheduled immediate job with ID: {quick_job_id}")
        await asyncio.sleep(5)  # Wait a bit, hoping it executes
        print(f"Attempting to cancel immediate job {quick_job_id} after a delay...")
        try:
            success = await notification_client.cancel(quick_job_id)
            print(
                f"Cancellation for quick job {quick_job_id}: {success} (expected false, as job is likely processed/gone)"
            )
        except NotitiaError as e:
            print(f"SDK Error cancelling quick job {quick_job_id}: {e.message}")

    except NotitiaError as e:
        print("\n--- SDK Error during scheduling/cancellation examples ---")
        print(f"Message: {e.message}")
        if e.status:
            print(f"Status: {e.status}")
        if e.response_data:
            print(f"Response Data: {e.response_data}")
        if e.cause:
            print(f"Cause: {e.cause}")
    except Exception as e:
        print("\n--- Unexpected Error during scheduling/cancellation examples ---")
        print(f"{type(e).__name__}: {e}")
    finally:
        print("\n--- Scheduling and Cancellation Examples Complete ---")


if __name__ == "__main__":

    async def run_standalone():
        await main()
        await notification_client.close()
        print("Client closed after standalone run.")

    asyncio.run(run_standalone())
