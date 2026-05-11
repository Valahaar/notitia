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
    """Jitter strategy applied to computed backoff (not to server-supplied delays)."""

    max_retry_after: float = 60.0
    """Cap on honored Retry-After / RateLimit-Reset / X-RateLimit-Reset.
    If the server requests a longer wait, the SDK gives up immediately
    rather than blocking the caller."""

    retry_status_codes: frozenset[int] = field(
        default_factory=lambda: frozenset({429, 500, 502, 503, 504})
    )
    """Status codes that trigger a retry."""
