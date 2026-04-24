# Logging

The Notitia Python SDK uses the standard library's `logging` module. It calls `logging.getLogger("notitia.events" | "notitia.contrib.beanie" | "notitia.contrib.fastapi")` internally and emits no records unless your application has configured a handler. This is intentional — libraries should not impose logging configuration on their hosts.

## GCP-compatible configuration

If your application runs on GCP (Cloud Run, GKE, Compute Engine) and you want the SDK's log records to interleave cleanly with Notitia service logs in the same Cloud Logging project, install a JSON formatter that emits the same keys the service uses.

### Minimal formatter (no extra deps)

```python
import json
import logging
from datetime import datetime, timezone

_SEVERITY = {
    "DEBUG": "DEBUG",
    "INFO": "INFO",
    "WARNING": "WARNING",
    "ERROR": "ERROR",
    "CRITICAL": "CRITICAL",
}

class GCPJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "severity": _SEVERITY.get(record.levelname, "DEFAULT"),
            "message": record.getMessage(),
            "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "context": record.name,
        }
        if record.exc_info:
            payload["stack_trace"] = self.formatException(record.exc_info)
            payload["@type"] = (
                "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent"
            )
        return json.dumps(payload)
```

### Wiring it up

```python
import logging
import sys

handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(GCPJsonFormatter())
logging.getLogger("notitia").addHandler(handler)
logging.getLogger("notitia").setLevel(logging.INFO)
```

### Correlating with trace context

If your host application is handling an HTTP request with an `X-Cloud-Trace-Context` header, inject it as `extra=` on individual calls, or use a logging filter to pull the trace from contextvars and attach it automatically. See the service-side spec at `docs/superpowers/specs/2026-04-24-structured-logging-design.md` for the exact field names the service emits.

### `python-json-logger` alternative

If you'd rather not hand-roll a formatter, the `python-json-logger` package ships a well-tested JSON formatter you can configure with the same field names via `rename_fields` and `static_fields`.
