import email.utils
import random
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import httpx


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
    """Jitter strategy applied to computed backoff (not to server-supplied delays)."""

    max_retry_after: float = 60.0
    """Cap on honored Retry-After / RateLimit-Reset / X-RateLimit-Reset.
    If the server requests a longer wait, the SDK gives up immediately
    rather than blocking the caller."""

    retry_status_codes: frozenset[int] = field(
        default_factory=lambda: frozenset({429, 500, 502, 503, 504})
    )
    """Status codes that trigger a retry."""


def _parse_retry_after(value: str) -> Optional[float]:
    """Parse a Retry-After header value (seconds or HTTP-date) into seconds.

    Returns None if the value cannot be parsed. May return a negative number
    for past dates; the caller is responsible for filtering."""
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    return parsed.timestamp() - time.time()


def _parse_rate_limit_headers(response: httpx.Response) -> Optional[float]:
    """Return the MAX of any present, parseable rate-limit headers (seconds).

    Inspects Retry-After (seconds or HTTP-date), RateLimit-Reset (seconds),
    and X-RateLimit-Reset (Unix timestamp). Negative, zero, and garbage
    values are skipped. Returns None when no usable value is found."""
    candidates: list[float] = []

    ra = response.headers.get("Retry-After")
    if ra is not None:
        parsed = _parse_retry_after(ra)
        if parsed is not None and parsed > 0:
            candidates.append(parsed)

    rlr = response.headers.get("RateLimit-Reset")
    if rlr is not None:
        try:
            v = float(rlr)
            if v > 0:
                candidates.append(v)
        except ValueError:
            pass

    xrlr = response.headers.get("X-RateLimit-Reset")
    if xrlr is not None:
        try:
            delta = float(xrlr) - time.time()
            if delta > 0:
                candidates.append(delta)
        except ValueError:
            pass

    return max(candidates) if candidates else None


def _backoff_delay(attempt: int, cfg: RetryConfig) -> float:
    """Compute exponential backoff delay for the given attempt (1-indexed)."""
    base = cfg.base_delay * (2 ** (attempt - 1))
    capped = min(base, cfg.max_delay)
    if cfg.jitter == "none":
        return capped
    if cfg.jitter == "full":
        return random.uniform(0, capped)
    return capped / 2 + random.uniform(0, capped / 2)


def _compute_delay(
    response: httpx.Response, attempt: int, cfg: RetryConfig
) -> Optional[float]:
    """Return delay in seconds, or None if server-supplied delay exceeds cap.

    On 429, server-supplied headers (Retry-After / RateLimit-Reset /
    X-RateLimit-Reset) take precedence over computed backoff. On any
    other retryable status, exponential backoff is always used."""
    if response.status_code == 429:
        server_delay = _parse_rate_limit_headers(response)
        if server_delay is not None:
            if server_delay > cfg.max_retry_after:
                return None
            return server_delay
    return _backoff_delay(attempt, cfg)
