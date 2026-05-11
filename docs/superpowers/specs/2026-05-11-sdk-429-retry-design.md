# Python SDK: 429 + 5xx Retry With Rate-Limit Header Support

**Date:** 2026-05-11
**Status:** Approved (brainstorming)
**Package:** `packages/python-sdk`

## Problem

The Python SDK's `LowLevelClient` raises `NotitiaError` on the first non-success response. When the Notitia service returns `429 Too Many Requests`, the caller has to implement their own backoff. The SDK should:

1. Honor server-supplied rate-limit headers (`Retry-After`, `RateLimit-Reset`, `X-RateLimit-Reset`) when present on a 429.
2. Fall back to bounded exponential backoff with jitter when no headers are present, and apply the same backoff to retryable 5xx responses.
3. Surface the final failure as a `NotitiaError` (existing type, no new public exception).

## Scope

In scope:
- Retries on `429` and `5xx` (`500, 502, 503, 504`) for both `POST /schedule` and `DELETE /schedule/:id`.
- Honoring `Retry-After`, `RateLimit-Reset`, `X-RateLimit-Reset` on 429s.
- Configuration via a new `RetryConfig` on `NotitiaClientConfig`.

Out of scope:
- Retrying network-level errors (`httpx.RequestError`, `ConnectError`, read timeouts). These propagate immediately.
- Per-call retry override on `PreparedEventData` / `emit()`. Defaults are library-wide.
- Logging from inside the SDK. Callers wrap if they want observability.
- New exception types. Retry-exhaustion surfaces as the existing `NotitiaError` with the final response's status code and body.

## Design

### Approach: inline retry loop on `LowLevelClient`

Add a private `_send_with_retries` helper on `LowLevelClient`. Each of the two request methods supplies an attempt closure; the helper drives the retry loop, parses headers, computes delay, and sleeps.

Rejected alternatives:
- **httpx custom transport** — Requires reimplementing rate-limit-aware retry inside the transport, awkward to surface retry-exhaustion as a typed error.
- **Third-party library (`tenacity`, `httpx-retries`)** — Adds a runtime dependency (SDK currently has only `httpx`); generic libraries don't natively handle all three header variants.

### New module: `packages/python-sdk/src/notitia/retry.py`

```python
from dataclasses import dataclass, field
from typing import Literal

@dataclass(frozen=True)
class RetryConfig:
    """Configuration for automatic retries on 429 and 5xx responses."""

    max_attempts: int = 5
    """Total attempts including the first. Set to 1 to disable retries."""

    base_delay: float = 0.5
    """Base seconds for exponential backoff: base_delay * 2 ** (attempt - 1)."""

    max_delay: float = 60.0
    """Cap (seconds) for the computed exponential backoff."""

    jitter: Literal["equal", "full", "none"] = "equal"
    """Jitter strategy applied to backoff (not to server-supplied delays)."""

    max_retry_after: float = 60.0
    """Cap (seconds) on honored Retry-After / RateLimit-Reset / X-RateLimit-Reset.
    If the server requests a longer wait, the SDK gives up immediately rather than
    blocking the caller, surfacing the 429 as a NotitiaError."""

    retry_status_codes: frozenset[int] = field(
        default_factory=lambda: frozenset({429, 500, 502, 503, 504})
    )
    """Status codes that trigger a retry."""
```

Re-exported from `notitia.__init__` as `RetryConfig`.

### Wiring into `NotitiaClientConfig`

```python
# packages/python-sdk/src/notitia/types.py
from .retry import RetryConfig

@dataclass
class NotitiaClientConfig:
    base_url: str = "http://localhost:60000"
    timeout: Optional[float] = 10.0
    default_headers: Optional[Dict[str, str]] = None
    default_queue: Optional[str] = None
    retry: RetryConfig = field(default_factory=RetryConfig)
```

`LowLevelClient.__init__` stores `self.retry_config = config.retry`.

### Retry loop

```python
import asyncio
import httpx
from typing import Awaitable, Callable

async def _send_with_retries(
    self,
    attempt_fn: Callable[[], Awaitable[httpx.Response]],
) -> httpx.Response:
    cfg = self.retry_config
    for attempt in range(1, cfg.max_attempts + 1):
        response = await attempt_fn()

        if response.status_code not in cfg.retry_status_codes:
            return response
        if attempt == cfg.max_attempts:
            return response

        delay = _compute_delay(response, attempt, cfg)
        if delay is None:
            return response  # server asked for longer than cap; give up
        await asyncio.sleep(delay)

    return response  # unreachable; satisfies type checker
```

Network errors (`httpx.RequestError`) raised inside `attempt_fn` are not caught here — they propagate to the caller, which wraps them in `NotitiaError` exactly as today.

### Delay computation

```python
import email.utils
import random
import time
from typing import Optional

def _compute_delay(
    response: httpx.Response, attempt: int, cfg: RetryConfig
) -> Optional[float]:
    """Return delay in seconds, or None if a server-supplied delay exceeds max_retry_after."""
    if response.status_code == 429:
        server_delay = _parse_rate_limit_headers(response)
        if server_delay is not None:
            if server_delay > cfg.max_retry_after:
                return None
            return server_delay
    return _backoff_delay(attempt, cfg)


def _parse_rate_limit_headers(response: httpx.Response) -> Optional[float]:
    """Return the MAX of any present rate-limit headers, or None if none parseable."""
    candidates: list[float] = []

    # Retry-After: seconds OR HTTP-date
    ra = response.headers.get("Retry-After")
    if ra is not None:
        parsed = _parse_retry_after(ra)
        if parsed is not None and parsed > 0:
            candidates.append(parsed)

    # RFC 9331: RateLimit-Reset = seconds until reset
    rlr = response.headers.get("RateLimit-Reset")
    if rlr is not None:
        try:
            v = float(rlr)
            if v > 0:
                candidates.append(v)
        except ValueError:
            pass

    # Vendor: X-RateLimit-Reset = unix timestamp
    xrlr = response.headers.get("X-RateLimit-Reset")
    if xrlr is not None:
        try:
            delta = float(xrlr) - time.time()
            if delta > 0:
                candidates.append(delta)
        except ValueError:
            pass

    return max(candidates) if candidates else None


def _parse_retry_after(value: str) -> Optional[float]:
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    parsed = email.utils.parsedate_to_datetime(value)
    if parsed is None:
        return None
    return parsed.timestamp() - time.time()


def _backoff_delay(attempt: int, cfg: RetryConfig) -> float:
    base = cfg.base_delay * (2 ** (attempt - 1))
    capped = min(base, cfg.max_delay)
    if cfg.jitter == "none":
        return capped
    if cfg.jitter == "full":
        return random.uniform(0, capped)
    # "equal"
    return capped / 2 + random.uniform(0, capped / 2)
```

### Integration points in `LowLevelClient`

`send_schedule_request`:

```python
async def _attempt() -> httpx.Response:
    return await self._http_client.post(url, json=filtered_data)

try:
    response = await self._send_with_retries(_attempt)
except httpx.RequestError as e:
    raise NotitiaError(message=..., cause=e) from e

if response.status_code != 202:
    # existing error path unchanged
    ...
```

`cancel_scheduled_job`: same pattern wrapping `self._http_client.delete(url)`.

The existing post-response logic (status check, JSON parse, `jobId` extraction) is unchanged.

## Behavior

### Defaults

- `max_attempts=5` (1 initial + 4 retries)
- `base_delay=0.5`, `max_delay=60.0`, `jitter="equal"`
- `max_retry_after=60.0`
- `retry_status_codes={429, 500, 502, 503, 504}`

### Backwards compatibility

Retries are **on by default**. Existing callers that previously saw an immediate `NotitiaError(status=429)` will now block up to a few seconds before either succeeding or raising. Callers can opt out with `NotitiaClientConfig(retry=RetryConfig(max_attempts=1))`.

### Server hints

- Only consulted on `429`. 5xx uses pure exponential backoff (no header parsing).
- All three header variants are checked. The **maximum** parseable value wins (most conservative).
- Malformed / negative / past-date values are ignored; if no value is parseable, fall back to backoff.
- Server-supplied delays do **not** receive jitter.
- Server-supplied delay > `max_retry_after` → SDK gives up immediately (returns the 429 to caller, who raises `NotitiaError`).

### Error surface

Retry-exhaustion → existing `NotitiaError` with the final response's `status` and `response_data`. No new exception type.

Network errors (`httpx.RequestError`, `ConnectError`, timeouts) → existing `NotitiaError` with `cause=e`, no retry.

### Public API additions

- `notitia.RetryConfig` (re-exported from `__init__`)
- `NotitiaClientConfig.retry: RetryConfig` field

Nothing else. `_send_with_retries`, `_compute_delay`, `_parse_*` are private module-level / method-level helpers.

## Testing

`packages/python-sdk/tests/` using `pytest` + `pytest-asyncio` + `respx`. Patch `asyncio.sleep` to keep tests fast and to assert exact sleep durations.

### Unit tests — `_compute_delay` / helpers

- Backoff with `jitter="none"`: attempt 1 returns `base_delay`; attempt n returns `base_delay * 2 ** (n - 1)`, capped at `max_delay`.
- `jitter="equal"`: result in `[capped/2, capped]`.
- `jitter="full"`: result in `[0, capped]`.
- `Retry-After: "5"` → 5.0.
- `Retry-After: <HTTP-date 5s in future>` → ≈ 5.0 (allow ±1s for timing).
- `Retry-After: <HTTP-date in past>` → fall back to backoff.
- `Retry-After: "garbage"` → fall back to backoff.
- `RateLimit-Reset: "10"` → 10.0.
- `X-RateLimit-Reset: <unix_now + 15>` → ≈ 15.0.
- Multiple headers present → returns the max.
- Server-supplied delay > `max_retry_after` → returns `None`.
- 5xx response → ignores headers, uses backoff.

### Integration tests — `send_schedule_request`

- 202 first try → returns `jobId`, zero sleeps.
- 429 once then 202 → returns `jobId`, one sleep observed.
- 500 once then 202 → returns `jobId`, one sleep observed.
- 429 with `Retry-After: 2` → sleep argument is exactly 2.0.
- 429 with `Retry-After: 600` and `max_retry_after=60` → raises immediately, **no** sleep.
- 429 on all 5 attempts → raises `NotitiaError(status=429)` after exactly 4 sleeps.
- `max_attempts=1` → no retries, first 429 raises immediately.
- `httpx.ConnectError` raised by transport → raises `NotitiaError`, no retry.

### Integration tests — `cancel_scheduled_job`

- 200 first try → returns boolean.
- 429 then 200 → returns boolean, one sleep.
- 500 then 200 → returns boolean, one sleep.

## Open questions

None — all clarifications resolved during brainstorming.

## Affected files

| File | Change |
|------|--------|
| `packages/python-sdk/src/notitia/retry.py` | NEW — `RetryConfig` + private helpers |
| `packages/python-sdk/src/notitia/types.py` | Add `retry: RetryConfig` field to `NotitiaClientConfig` |
| `packages/python-sdk/src/notitia/low_level_client.py` | Add `_send_with_retries`; wrap POST/DELETE call sites |
| `packages/python-sdk/src/notitia/__init__.py` | Export `RetryConfig` |
| `packages/python-sdk/tests/test_retry.py` | NEW — unit + integration tests |
| `.knowledge/subsystems/python-sdk.md` | Document retry behavior in Invariants / Known Pitfalls |
