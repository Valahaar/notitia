import email.utils
import time
from dataclasses import dataclass, field
from typing import Literal, Optional


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
