import json

import httpx
import respx

import notitia
from notitia.common_types import HttpMethod, RecurringSchedule, ScheduleRequest
from notitia.low_level_client import LowLevelClient
from notitia.types import NotitiaClientConfig


def _client() -> LowLevelClient:
    return LowLevelClient(NotitiaClientConfig(base_url="http://service"))


def _request(schedule: RecurringSchedule) -> ScheduleRequest:
    return ScheduleRequest(
        target="http://example.com/hook",
        method=HttpMethod.POST,
        schedule=schedule,
    )


@respx.mock
async def test_timezone_is_sent():
    route = respx.post("http://service/schedule").mock(
        return_value=httpx.Response(202, json={"jobId": "job-1"})
    )
    client = _client()
    await client.send_schedule_request(
        _request(RecurringSchedule(schedule="0 9 * * *", timezone="Europe/Rome"))
    )
    body = json.loads(route.calls[0].request.content)
    assert body["schedule"] == {
        "type": "recurring",
        "schedule": "0 9 * * *",
        "timezone": "Europe/Rome",
    }
    await client.close()


@respx.mock
async def test_timezone_omitted_when_none():
    route = respx.post("http://service/schedule").mock(
        return_value=httpx.Response(202, json={"jobId": "job-1"})
    )
    client = _client()
    await client.send_schedule_request(
        _request(RecurringSchedule(schedule="0 9 * * *"))
    )
    body = json.loads(route.calls[0].request.content)
    assert "timezone" not in body["schedule"]
    await client.close()


def test_header_constants_exported():
    assert notitia.NOTITIA_TASK_ID_HEADER == "X-Notitia-Task-ID"
    assert notitia.NOTITIA_OCCURRENCE_HEADER == "X-Notitia-Occurrence"
    assert "NOTITIA_TASK_ID_HEADER" in notitia.__all__
    assert "NOTITIA_OCCURRENCE_HEADER" in notitia.__all__
