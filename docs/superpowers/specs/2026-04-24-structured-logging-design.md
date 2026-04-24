# Structured Logging for Notitia Service

**Date:** 2026-04-24
**Status:** Draft — pending review
**Scope:** `packages/service` (runtime code + config); `packages/python-sdk` (docs only)

## Problem

The NestJS service uses the default `@nestjs/common` `Logger`, which emits colorized text to stdout. When deployed to GCP, Cloud Logging ingests each line as an unstructured `textPayload` with `severity=DEFAULT`, so:

- No severity-level filtering in the Logs Explorer.
- No correlation across log entries for a single request.
- Multi-line stack traces from exception filters are split into separate log entries.
- No integration with Cloud Error Reporting.
- No operator control at runtime — the log level is baked in.

Today's code already contains rich, semi-structured ad-hoc patterns that deserve to be first-class fields:

- `[${taskId}] ...` / `[${ufid}] ...` prefixes on ~30 log lines.
- `[audit] scheduled job=... target=... method=...` lines in `JobSchedulingController`.
- `safeUrl()` URL sanitization applied by hand at each site.

## Goals

1. Emit structured JSON on stdout that Cloud Logging auto-parses into `jsonPayload` with correct `severity`.
2. Correlate every log line emitted during an HTTP request with both a stable `requestId` (from the existing middleware) and the Cloud Run–provided `X-Cloud-Trace-Context` trace/span IDs.
3. Route error-level entries with stacks to Cloud Error Reporting via the documented `@type` marker.
4. Give operators runtime control via environment variables: log level, output format, sampling of high-volume success logs, and redaction.
5. Preserve every existing `this.logger.log/warn/error(...)` call site — no big-bang migration.
6. Leave the Python SDK's runtime code alone; document how SDK consumers configure a GCP-compatible formatter.

## Non-goals

- Emitting OpenTelemetry spans from the service.
- Shipping logs to any destination other than stdout (Cloud Run / GKE logging agents handle ingestion).
- Metric derivation from log lines.
- Per-logger-namespace level overrides (deferred; easy to add later if needed).
- Changes to Python SDK runtime code.

## Approach

Adopt `pino` via `nestjs-pino` as the sole `LoggerService` implementation. Override NestJS's built-in logger at bootstrap. Request-scoped context (requestId, Cloud Trace fields) flows through `AsyncLocalStorage` — `nestjs-pino` manages this automatically via its middleware. Sampling and redaction are implemented as pino configuration hooks. All behavior is controlled by a small set of environment variables with sensible dev/prod defaults.

### Why pino over alternatives

- **vs custom `LoggerService`:** pino already solves redaction, ALS context propagation, format toggling, severity mapping, and hot-path performance. A hand-rolled JSON logger is ~500 lines of maintenance for what pino does in ~30 lines of config.
- **vs winston:** winston doesn't ship request-scoped context — we'd bolt on `AsyncLocalStorage` ourselves. Winston is also materially slower on hot paths (pino's binary serializer is ~10–20× faster on `JSON.stringify`-heavy loads).
- **NestJS ecosystem fit:** `nestjs-pino` is the de facto standard structured logger for NestJS and has stable APIs.

## Architecture

### Files added

- `src/common/logger/logger.module.ts` — `LoggerModule.forRoot(...)` configuration. Imported once in `AppModule`.
- `src/common/logger/trace.ts` — `parseCloudTrace(header, projectId)` helper. Returns the three `logging.googleapis.com/*` fields or `{}`.
- `src/common/logger/redact.ts` — builds the pino `redact.paths` array from the default list plus `LOG_REDACT`.
- `src/common/logger/sampler.ts` — pino `hooks.logMethod` implementation that drops `info` lines tagged `sampleable: true` according to `LOG_SAMPLE_RATE`.
- `src/common/logger/helpers.ts` — `logAudit(logger, event, fields)` and `logError(logger, err, fields)` helpers.
- `src/common/middleware/trace-context.middleware.ts` — parses `X-Cloud-Trace-Context` and attaches parsed fields to `req` for `nestjs-pino` to pick up (runs after `RequestIdMiddleware`).
- `packages/python-sdk/docs/logging.md` — docs-only addition for SDK consumers.

### Files modified

- `src/app.module.ts` — import `LoggerModule`, register `TraceContextMiddleware` on all routes.
- `src/main.ts` — `app.useLogger(app.get(Logger))` to replace NestJS's default logger.
- `src/common/filters/all-exceptions.filter.ts`, `src/common/filters/http-exception.filter.ts` — use `logError` helper.
- `src/modules/job-scheduling/job-scheduling.controller.ts` — `[audit]` lines become `logAudit(...)` calls.
- `src/modules/job-scheduling/job-scheduling.service.ts` — drop the `this.logger.log('received-job-scheduling', scheduleRequestDto)` form that dumps the whole DTO into the log string; replace with structured fields.
- `packages/service/README.md`, `docker-compose.yml`, service env-var table — document new variables.

### Files unchanged (intentionally)

- All `new Logger(ClassName)` instantiations stay — `nestjs-pino` implements the same interface.
- `src/common/middleware/request-id.middleware.ts` — still authoritative for `X-Request-ID`.
- `src/common/utils/log.util.ts` (`safeUrl`) — still used at call sites for query-string stripping.
- All Python SDK code.

## Canonical log record

```json
{
  "severity": "INFO",
  "time": "2026-04-24T10:11:12.345Z",
  "message": "Scheduled direct relay 2026-04-25T10:00:00Z",
  "context": "GcpTaskSchedulerService",
  "requestId": "b8e3e6f1-...",
  "logging.googleapis.com/trace": "projects/my-gcp/traces/abc123...",
  "logging.googleapis.com/spanId": "def456...",
  "logging.googleapis.com/trace_sampled": true,
  "jobId": "1234567890",
  "target": "https://example.com/webhook",
  "schedule": "on",
  "method": "POST"
}
```

### Field contract

| Field | When present | Notes |
|---|---|---|
| `severity` | always | Maps pino level via `formatters.level`. `trace→DEBUG`, `debug→DEBUG`, `info→INFO`, `warn→WARNING`, `error→ERROR`, `fatal→CRITICAL`. |
| `time` | always | Pino default, ISO 8601. GCP will also auto-assign `timestamp` on ingest. |
| `message` | always | Renamed from pino's `msg` via `messageKey: 'message'`. |
| `context` | always | NestJS class name from `new Logger(name)`. |
| `requestId` | during HTTP request | From `X-Request-ID`. Absent in scheduler timeout callbacks, module init, etc. |
| `logging.googleapis.com/trace` | when `X-Cloud-Trace-Context` header present | Fully qualified as `projects/{GCP_PROJECT_ID}/traces/{TRACE_ID}` when `GCP_PROJECT_ID` is set; bare trace ID otherwise. |
| `logging.googleapis.com/spanId` | same condition | Extracted span segment. |
| `logging.googleapis.com/trace_sampled` | same condition | Boolean from the `;o=1` flag. |
| `logging.googleapis.com/sourceLocation` | when `LOG_INCLUDE_SOURCE=true` or `LOG_LEVEL=debug` | `{ file, line, function }`. Has a non-zero cost because it captures a stack; off by default in prod. |
| `audit` | on audit events | Always `true`. Emitted via `logAudit` helper. |
| `event` | on audit events | Dotted event name, e.g. `job.scheduled`, `job.cancelled`. |
| `@type` | on error-level records with a stack | `type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent` — routes to Error Reporting. |
| `stack_trace` | on error-level records with a stack | Formatted stack Error Reporting expects. |
| Domain fields (`jobId`, `target`, `method`, `queue`, `ufid`, `status`, `durationMs`, `retryCount`, ...) | per log site | First-class fields instead of string-interpolated prefixes. |

## Request-scoped context

1. `RequestIdMiddleware` runs first — sets `req.headers['x-request-id']` and the response header. Unchanged.
2. `TraceContextMiddleware` runs second — parses `X-Cloud-Trace-Context`, stores parsed fields on `req`.
3. `nestjs-pino`'s middleware (registered by `LoggerModule.forRoot`) runs next — opens an `AsyncLocalStorage` scope with a child logger pre-bound to the request's correlation fields via `customProps`:

```ts
customProps: (req) => ({
  requestId: req.headers['x-request-id'],
  ...req.traceContext, // populated by TraceContextMiddleware
})
```

Every log emitted in handlers, services, filters, axios callbacks inside the request scope inherits these fields. Logs emitted outside the scope (scheduler timeout callbacks, module init) do not — they rely on `jobId`/`ufid` in the payload for correlation.

## Configuration surface

| Variable | Default (dev) | Default (prod) | Validation | Description |
|---|---|---|---|---|
| `LOG_LEVEL` | `debug` | `info` | One of `trace\|debug\|info\|warn\|error\|fatal` | Minimum level emitted. |
| `LOG_FORMAT` | `pretty` | `json` | `json` or `pretty` | `pretty` loads `pino-pretty` (dev dep); `json` is the canonical GCP format. |
| `LOG_SAMPLE_RATE` | `1.0` | `1.0` | Float in `[0, 1]` | Rate at which `info` logs tagged `sampleable: true` are kept. `warn`/`error`/`fatal`/audit never sampled. |
| `LOG_REDACT` | `` | `` | Comma-separated pino paths | Appended to the default redact list. |
| `LOG_INCLUDE_SOURCE` | `false` | `false` | `true` or `false` | When `true` (or when `LOG_LEVEL=debug`), emit `logging.googleapis.com/sourceLocation`. |

Dev mode is selected when `NODE_ENV !== 'production'`. Validation runs at bootstrap; invalid values fail fast with the same pattern as the existing `AUTH_TOKEN` validation in `app.module.ts`.

## Sampling

Only `HttpExecutorService` tags its success-path logs (`Executing ...` + `Success ...`) with `sampleable: true`. The sampler hook:

1. Unconditionally passes `warn`/`error`/`fatal`.
2. Unconditionally passes any record where `audit === true`.
3. For `info` records with `sampleable === true`, drops with probability `1 - LOG_SAMPLE_RATE` (single `Math.random()` per call).
4. Otherwise passes.

Failure-path logs in `HttpExecutorService` are `error`-level, so they are never sampled. This is the narrow-by-design choice: sampling applies only to the 2× per-job success noise, not to any event where "did this happen?" matters.

## Redaction

pino's `redact.paths` is built from:

- Static defaults (always on):
  - `req.headers.authorization`
  - `req.headers.cookie`
  - `req.headers["x-goog-*"]`
  - `*.password`, `*.token`, `*.secret`, `*.apiKey`, `*.api_key` (deep, case-insensitive via pino's path syntax)
- User-supplied `LOG_REDACT`, appended but cannot remove defaults.

Redacted values become `[REDACTED]`. `safeUrl()` continues to strip query strings at call sites where the URL is part of the `message` string — redaction paths don't help there.

## Audit logs

`logAudit(logger, event, fields)` emits at `info` with `{ audit: true, event, ...fields }`. Operators build a Cloud Logging sink on `jsonPayload.audit=true` to archive audit trails separately. Current audit sites:

- `JobSchedulingController` line 58 → `logAudit(this.logger, 'job.scheduled', { jobId, target, method, schedule })`.
- `JobSchedulingController` line 72 → `logAudit(this.logger, 'job.cancelled', { jobId, queue, result })`.

## Error Reporting

`logError(logger, err, fields)`:

1. Serializes the error's `message` and `stack`.
2. Emits at `error` with `{ @type: 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent', message, stack_trace: formattedStack, ...fields }`.

Error Reporting auto-groups these without any GCP-side config. Applied in both exception filters.

## Migration of existing log sites

Both old and new forms coexist — the old `this.logger.log('text')` form still works through `nestjs-pino`. Migration is opportunistic except for four forced cases:

**Forced now:**
1. Both exception filters → `logError(...)`.
2. The two `[audit]` lines in `JobSchedulingController` → `logAudit(...)`.
3. `HttpExecutorService` success pair — must be tagged `sampleable: true` to participate in sampling, and its domain fields (`taskId`, `method`, `target`, `status`, `durationMs`) must be first-class so operators can query them.
4. `JobSchedulingService.scheduleJobProcessing` line 16 — the `this.logger.log('received-job-scheduling', scheduleRequestDto)` call currently passes the whole DTO as the second arg (a NestJS "context" position), which pino will misinterpret. Must be rewritten as a structured record.

**Opportunistic (everything else):** the ~30 remaining `[${jobId}] ...` call sites become structured when they're next touched. A follow-up clean-up PR can sweep the rest when convenient.

### Pattern

Before:
```ts
this.logger.log(`[${taskId}] Executing ${method} ${safeUrl(target)}`);
```

After:
```ts
this.logger.log({ jobId: taskId, method, target: safeUrl(target), sampleable: true }, 'Executing');
```

## Python SDK (docs only)

New file `packages/python-sdk/docs/logging.md` covering:

- The SDK uses stdlib `logging.getLogger("notitia.events" | "notitia.contrib.beanie" | "notitia.contrib.fastapi")` and emits no records unless the host configures a handler.
- A copy-paste `logging.Formatter` subclass that outputs the same canonical JSON shape as the service, so SDK-side logs interleave cleanly with service-side logs in one Cloud Logging project.
- How to plug it into `logging.dictConfig` / FastAPI / Beanie apps.

No SDK runtime changes.

## Testing

**Unit tests** (`*.spec.ts`):
- `parseCloudTrace`:
  - Valid header with `;o=1` → all three fields set, `trace_sampled: true`.
  - Valid header with `;o=0` → `trace_sampled: false`.
  - Header without span → span field absent, trace field set.
  - Malformed header → empty object, no throw.
  - `GCP_PROJECT_ID` set → fully-qualified `projects/{id}/traces/{trace}`.
- `sampler`:
  - `warn`/`error` pass with rate=0.
  - `audit: true` passes with rate=0.
  - `sampleable: true` at `info` — Monte Carlo 10k draws, assert proportion within tolerance of configured rate.
  - No `sampleable` flag → passes regardless of rate.
- `redact`:
  - Default paths cover `authorization`, `cookie`, `password`, `token`, `secret`.
  - `LOG_REDACT=custom.path` is merged, defaults remain.
- `logAudit` / `logError`:
  - Shape assertions on the emitted record (`audit: true`, `@type`, `stack_trace` present).

**Integration tests** (`test/e2e` style):
- Boot `AppModule` with `LOG_FORMAT=json` under `supertest`.
- Capture stdout, parse each line.
- Send a request with `X-Cloud-Trace-Context` header; assert all three trace fields on the controller's log line.
- Send a request with `Authorization: Bearer xxx`; assert it appears as `[REDACTED]` in request logs.
- Trigger an unhandled exception; assert the log record has `@type` and `stack_trace`.

**Format sanity:**
- One test pipes a sample log through the real pino config and validates against a JSON schema derived from the "Field contract" table above.

## Rollout

1. Land logger infra + config on `main` with no call-site migrations → pino is active, all existing text logs become structured (just without domain fields). Verify Cloud Logging ingests them correctly at the `severity` level.
2. Migrate the four forced sites (filters, audit, executor, scheduling service).
3. Opportunistic sweep PR for remaining sites.

## Open questions

None at time of writing.
