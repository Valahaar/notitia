from asyncio import iscoroutine
from datetime import datetime, timezone
from typing import Any, Tuple

import jsonpickle
from beanie import Document

from ..jwt import Jwt

# Configure jsonpickle
jsonpickle.set_preferred_backend("json")
jsonpickle.set_encoder_options("json", ensure_ascii=False, indent=None)


@jsonpickle.handlers.register(Document, base=True)
class MongoDocumentHandler(jsonpickle.handlers.BaseHandler):
    def flatten(self, obj, data):
        data["id"] = str(obj.id)
        return data

    def restore(self, obj):
        cls = jsonpickle.unpickler.loadclass(obj["py/object"])
        return cls.get(obj["id"])


class NotitiaSerializer:
    """Secure wrapper around jsonpickle using JWT for integrity"""

    @classmethod
    def serialize_and_sign(cls, *args, **kwargs) -> str:
        """Serialize args/kwargs and sign with JWT"""
        # Create payload with args and kwargs
        payload_data = {
            "args": jsonpickle.encode(args, unpicklable=True),
            "kwargs": jsonpickle.encode(kwargs, unpicklable=True),
            "timestamp": datetime.now(timezone.utc).isoformat(),  # For audit/debugging
            "version": "1.0",  # For future compatibility
        }

        # Sign the entire payload with JWT
        jwt_token = Jwt.encode(payload_data)
        return jwt_token

    @classmethod
    async def verify_and_deserialize(cls, jwt_token: str) -> Tuple[tuple, dict]:
        """Verify JWT signature and deserialize args/kwargs"""
        try:
            # Verify JWT signature and decode payload
            payload_data = Jwt.decode(jwt_token)

            # Extract and deserialize args/kwargs
            args_json = payload_data["args"]
            kwargs_json = payload_data["kwargs"]

            args = jsonpickle.decode(args_json)
            kwargs = jsonpickle.decode(kwargs_json)

            # Handle async deserialization for database objects
            args, kwargs = await cls._resolve_async_objects((args, kwargs))

            return args, kwargs

        except Exception as e:
            raise ValueError(f"Failed to verify or deserialize JWT payload: {e}")

    @classmethod
    async def _resolve_async_objects(cls, obj: Any) -> Any:
        """Handle async deserialization of database documents"""
        if isinstance(obj, (list, tuple)):
            resolved = []
            for item in obj:
                resolved.append(await cls._resolve_async_objects(item))
            return type(obj)(resolved)
        elif isinstance(obj, dict):
            resolved = {}
            for key, value in obj.items():
                resolved[key] = await cls._resolve_async_objects(value)
            return resolved
        elif iscoroutine(obj):
            return await obj
        else:
            return obj
