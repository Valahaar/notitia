import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Protocol, Tuple


class EventSerializer(Protocol):
    """Protocol for serializing event handler arguments.

    The default ``JsonSerializer`` handles JSON-serializable types.
    Implement this protocol for richer serialization (e.g. ORM documents,
    arbitrary Python objects via jsonpickle + JWT, etc.).
    """

    def serialize(self, *args: Any, **kwargs: Any) -> str: ...

    async def deserialize(self, payload: str) -> Tuple[tuple, dict]: ...


class JsonSerializer:
    """Default serializer using stdlib ``json``.

    Optionally signs payloads with HMAC-SHA256 to detect tampering.

    Args:
        signing_key: Secret key for HMAC signing. When ``None``,
            payloads are not signed and signature verification is skipped.
    """

    def __init__(self, signing_key: str | None = None):
        self._signing_key = signing_key

    def serialize(self, *args: Any, **kwargs: Any) -> str:
        payload = {
            "args": list(args),
            "kwargs": kwargs,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "version": "1.0",
        }
        body = json.dumps(payload, default=str, ensure_ascii=False)
        if self._signing_key is not None:
            sig = self._compute_signature(body)
            envelope = json.dumps({"body": body, "sig": sig}, ensure_ascii=False)
            return envelope
        return body

    async def deserialize(self, payload: str) -> Tuple[tuple, dict]:
        data = json.loads(payload)

        # Signed envelope
        if self._signing_key is not None and "body" in data and "sig" in data:
            expected = self._compute_signature(data["body"])
            if not hmac.compare_digest(expected, data["sig"]):
                raise ValueError("HMAC signature verification failed")
            data = json.loads(data["body"])
        elif self._signing_key is not None and "body" not in data:
            raise ValueError(
                "Signing key is configured but payload is not signed"
            )

        args = tuple(data.get("args", []))
        kwargs = data.get("kwargs", {})
        return args, kwargs

    def _compute_signature(self, body: str) -> str:
        return hmac.new(
            self._signing_key.encode(),
            body.encode(),
            hashlib.sha256,
        ).hexdigest()
