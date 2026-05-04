---
description: Structured logging via nestjs-pino — env-driven control, GCP-native fields, request correlation, audit and Error Reporting routing
---

# Subsystem: Logging

## Scope

The service uses `nestjs-pino` as its sole `LoggerService`. All logs emit as single-line JSON on stdout in production; `pino-pretty` is used in dev when `LOG_FORMAT=pretty`. Lives under `packages/service/src/common/logger/`.

## Responsibilities

- Emit GCP-native log records: `severity`, `message`, `logging.googleapis.com/trace|spanId|trace_sampled|sourceLocation`.
- Correlate every log line inside an HTTP request with `requestId` and GCP trace fields. Both are parsed inline in `customProps` (in `logger.module.ts`) because pino-http fires before NestJS `configure()` middleware — `RequestIdMiddleware` only writes the ID back to the response header.
- Route stack-bearing error logs to Cloud Error Reporting via the `@type` marker on `logError(...)`.
- Tag audit events (`logAudit(...)`) with `audit: true` + `event` for easy sink construction.
- Apply env-controlled sampling only to `HttpExecutorService`'s success-path logs (tagged `sampleable: true`). Warn/error/audit are never sampled.
- Redact `authorization`, `cookie`, `password`, `token`, `secret`, `apiKey` paths by default; `LOG_REDACT` appends.

## Environment variables

| Variable | Default (prod / dev) | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` / `debug` | `trace|debug|info|warn|error|fatal` |
| `LOG_FORMAT` | `json` / `pretty` | `json` for Cloud Logging |
| `LOG_SAMPLE_RATE` | `1.0` | Rate for `sampleable: true` info logs |
| `LOG_REDACT` | `` | Comma-separated pino paths |
| `LOG_INCLUDE_SOURCE` | `false` (auto-`true` if level=debug) | Enables `logging.googleapis.com/sourceLocation` |

All validated at startup; invalid values fail the bootstrap with a descriptive error.

## Call-site conventions

- `this.logger.log('msg')` — legacy form, still works.
- `this.logger.log({ field: value }, 'msg')` — preferred for new code.
- `logAudit(this.logger, 'job.scheduled', { jobId, ... })` — business events.
- `logError(this.logger, err, { jobId, ... })` — error-level with stack. Use only for genuine server errors; it stamps the Cloud Error Reporting `@type` and would otherwise flood incidents with expected failures. `HttpExceptionFilter` gates this on `status >= 500`; 4xx log via `this.logger.error(...)` without the marker.
- Tag `sampleable: true` only on high-volume success logs (currently only `HttpExecutorService` `Executing` / `Success` pair).
- Failure-path logs must be self-contained: include `target` (via `safeUrl`), `method`, and any identifiers needed to debug the failure without correlating to a sibling log. The success-path entry log may be sampled away, so do not rely on `taskId`/`requestId` correlation alone.
- For HTTP failures from downstream services (`HttpExecutorService`), log: `status`, `statusText`, `errorCode` (axios code like `ECONNABORTED`), `durationMs`, `responseContentType`, `downstreamRequestId` (from `x-request-id` / `x-cloud-trace-context`), and the response body via `normalizeResponseBody` — which emits `<empty>` for missing bodies and truncates at 4 KB with `responseBodyTruncated: true`.

## Key files

- `common/logger/logger.module.ts` — NestJS module, pino config.
- `common/logger/config.ts` — env reader + validator.
- `common/logger/trace.ts` — `parseCloudTrace`.
- `common/logger/sampler.ts` — level-aware sampling hook.
- `common/logger/redact.ts` — default + user redact path builder.
- `common/logger/severity.ts` — pino-label → GCP-severity mapping.
- `common/logger/helpers.ts` — `logAudit` / `logError`.
## Related

- [API Contract](../conventions/api-contract.md) — endpoints that emit audit logs.
- [System Overview](../architecture/system-overview.md) — hardening and middleware chain.
