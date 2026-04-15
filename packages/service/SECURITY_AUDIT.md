# Security & Design Audit — packages/service/

**Date:** 2026-04-08  
**Status:** Resolved (except DES-1 and AUTH-3)

---

## Critical — RESOLVED

### ~~AUTH-1: Weak token comparison in AuthGuard~~ ✓
**Fix:** `crypto.timingSafeEqual()` for constant-time comparison, `startsWith('Bearer ')` + `slice(7)` for proper parsing.

### ~~AUTH-2: Header injection via user-supplied headers~~ ✓
**Fix:** Headers with CRLF (`\r`, `\n`) in name or value are dropped with a warning log before outgoing requests.

### AUTH-3: GCP relay endpoints trust model — DEFERRED
Relay/meta endpoints use the same Bearer guard. OIDC token verification would be the GCP-native approach but requires architectural changes. Current pattern is acceptable for self-hosted infra where the service creates its own GCP tasks with the same token.

---

## High — RESOLVED

### ~~SEC-1: No rate limiting or body size limit~~ ✓
**Fix:** `@nestjs/throttler` (100 req/min globally via `APP_GUARD`), `express.json({ limit: '1mb' })`.

### ~~SEC-2: No security headers~~ ✓
**Fix:** `helmet()` middleware added.

### ~~SEC-3: Exception filter disabled — stack traces leak~~ ✓
**Fix:** `HttpExceptionFilter` re-enabled. New `AllExceptionsFilter` catches non-HTTP exceptions and returns generic 500.

### ~~SEC-4: Unvalidated payloads~~ ✓
**Fix:** Covered by 1MB body size limit (SEC-1).

### ~~SEC-5: No HTTP timeout on outgoing requests~~ ✓
**Fix:** 30s timeout on all outgoing Axios requests.

---

## Medium — RESOLVED (except DES-1)

### DES-1: Zero tests — OPEN
No `.spec.ts` files found. Standalone effort for a future sprint.

### ~~DES-2: No env validation at startup~~ ✓
**Fix:** `ConfigModule.forRoot({ validate })` checks `AUTH_TOKEN` at boot. GCP vars already validated in `GcpTaskSchedulerService` constructor.

### ~~DES-3: Swallowed errors in job cancellation~~ ✓
**Fix:** Removed try/catch in `cancelScheduledJobProcessing` — errors propagate to controller and exception filters. GCP `cancelJob` now only returns `false` for NOT_FOUND, throws on other errors.

### ~~DES-4: No request tracing / correlation IDs~~ ✓
**Fix:** `RequestIdMiddleware` generates `X-Request-ID` (UUID) per request, preserves incoming ones, returns in response header.

### ~~DES-5: Sensitive data in logs~~ ✓
**Fix:** `safeUrl()` utility strips query strings (`?[REDACTED]`). Applied across all log statements in GCP scheduler, relay controller, meta controller/service, HTTP executor, in-memory scheduler, and job scheduling controller.

### ~~DES-6: In-memory scheduler has no retry logic~~ ✓
**Fix:** `executeJob` retries up to 3 times with exponential backoff (1s, 2s, 4s) on failed HTTP status or thrown errors.

### ~~DES-7: `any[]` types in module configuration~~ ✓
**Fix:** Replaced with `Parameters<typeof Module>[0]['imports']` and `['providers']`.

---

## Low — RESOLVED (except LOW-2, LOW-3)

### ~~LOW-1: Public methods that should be private~~ ✓
**Fix:** `getRedisKeyForJob` and `restrictScheduleTime` made private. Other methods remain accessible as needed by `MetaService`.

### LOW-2: Tight coupling to GCP in core interfaces — ACCEPTED
`IJobScheduler` already abstracts the scheduler. GCP-specific details are contained within the `gcp-scheduling` module. Acceptable trade-off.

### LOW-3: Axios imported directly instead of injected — ACCEPTED
Single usage site, not worth the abstraction overhead. Timeout is now configured inline.

### ~~LOW-4: No health/readiness endpoint~~ ✓
**Fix:** `GET /health` endpoint added via `HealthController`, with `@SkipThrottle()`.

### ~~LOW-5: Inconsistent error handling patterns~~ ✓
**Fix:** GCP `cancelJob` now throws on real errors (only returns `false` for NOT_FOUND). `cancelScheduledJobProcessing` propagates errors. Exception filters handle the rest.

### ~~LOW-6: No audit logging~~ ✓
**Fix:** `[audit]` log lines in `JobSchedulingController` for both schedule and cancel operations, including job ID, sanitized target, method, schedule type, and result.

---

## Not an issue (reviewed and dismissed)

### ~~SSRF via user-supplied target URL~~
Notitia is a blind async HTTP execution engine — responses are never returned to the caller. It's deployed in the user's own infra where hitting internal endpoints is the intended use case. The real defense is auth (AUTH-1/AUTH-3), not URL filtering.

### ~~Unauthenticated /schedule endpoint~~
By design. Notitia uses a moat-and-castle model: `/schedule` is only reachable within the VPC by internal services, so no auth is needed. Adding auth would spread the `AUTH_TOKEN` to every calling service, widening the secret's blast radius. Auth is only on `/relay` and `/meta` because GCP Cloud Tasks callbacks traverse outside the VPC boundary. Network-level isolation is the trust boundary for `/schedule`.
