# Notitia: Cloud Tasks reliability (N1) and recurring correctness (N2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Notitia survive a dead Cloud Tasks connection without duplicating tasks (N1), and make recurring schedules fork-free, cancellable, time-zone aware and occurrence-identified (N2).

**Architecture:** N1 puts every Cloud Tasks call behind one client holder that sets keepalive, a short per-attempt deadline, and rebuild-and-retry on DEADLINE_EXCEEDED/UNAVAILABLE; every task gets a hashed name so a retry hits ALREADY_EXISTS. N2 names meta and relay tasks from (schedule id, occurrence), stops chains with a tombstone, and threads an IANA time zone and the occurrence time through the schedule helper, both schedulers and the relay headers.

**Tech Stack:** NestJS 10, `@google-cloud/tasks` 6.2.1 (google-gax 5.0.6, `@grpc/grpc-js` 1.14.3), cron-parser 5.5.0, rrule 2.8.1, cache-manager + Keyv (Mongo in prod), Jest 29; Python SDK (httpx, pytest-asyncio).

**Spec:** `docs/superpowers/specs/2026-11-16-cloud-tasks-reliability-and-recurring-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- Repo: `/home/nick/principled/.orchard-worktrees/session-batched-evals/notitia`. N1 on branch `fix/cloud-tasks-reliability` (exists, carries the spec). N2 on `fix/recurring-schedules`, branched from N1's head after Task 3.
- Service commands run in `packages/service` (`yarn install` once; `yarn test <path>`; `yarn build`). SDK commands run in `packages/python-sdk` (`uv run pytest`).
- Task name characters `[A-Za-z0-9_-]`, at most 500; names are hashes, never sequential or time-prefixed.
- gRPC codes: INVALID_ARGUMENT 3, DEADLINE_EXCEEDED 4, NOT_FOUND 5, ALREADY_EXISTS 6, UNAVAILABLE 14.
- Retry numbers (N1): per-attempt deadline 8000 ms; total budget 25000 ms; keepalive time 60000 ms, timeout 10000 ms, permit without calls. Tombstone TTL 60 days.
- Absent `timezone` means UTC. Header names: `X-Notitia-Task-ID` (unchanged), `X-Notitia-Occurrence` (new, ISO-8601 UTC with milliseconds, `Date.toISOString()`).
- No infrastructure changes (queues, instance counts).
- Knowledge edits ship in the same commit as the code that makes them stale (`.knowledge/subsystems/gcp-scheduling.md`, `in-memory-scheduling.md`, `python-sdk.md`, `conventions/api-contract.md`).
- Run only the affected test files per task; the full service and SDK suites once at the end of N1 and of N2.

## Review Focus

- A Cloud Tasks call that hangs past its deadline while other requests are in flight: all of them must share one rebuild, not build a client each (Task 1 test `rebuilds once for concurrent failures`).
- A caller retrying a keyed request after Notitia already created the task: same job id back, no second task (Task 2 test `returns the same id when the keyed task already exists`).
- A meta delivery retried minutes later, after an occurrence boundary passed: no second chain survives past the next shared occurrence (Task 6 test `a late retry converges on the next shared occurrence`).
- A cancel issued with no `queue` for a schedule created with queue `jobs` (the backend's queue): the chain stops (Task 7 test `cancel without queue stops a jobs-queue schedule`).
- `0 21 * * *` with `timezone: Europe/Rome` across 2026-10-25: 19:00Z before, 20:00Z after (Task 4 test `cron keeps local time across DST`).

---

## Part N1 — reliability (branch `fix/cloud-tasks-reliability`)

### Task 1: Cloud Tasks client holder with keepalive, short deadline, rebuild and retry

**Files:**
- Create: `packages/service/src/modules/gcp-scheduling/cloud-tasks-client.holder.ts`
- Create: `packages/service/src/modules/gcp-scheduling/cloud-tasks-client.holder.spec.ts`
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` (constructor, `getClient`, `createTask`'s retry loop, `cancelJob`'s `deleteTask`)
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.spec.ts` (the `makeService` stub and the "does not retry other gRPC errors" test)
- Modify: `.knowledge/subsystems/gcp-scheduling.md`

**Interfaces:**
- Produces:
  - `export const CLOUD_TASKS_KEEPALIVE_OPTIONS = { 'grpc.keepalive_time_ms': 60000, 'grpc.keepalive_timeout_ms': 10000, 'grpc.keepalive_permit_without_calls': 1 }`
  - `export class CloudTasksClientHolder { constructor(factory: () => CloudTasksClient = () => new CloudTasksClient(CLOUD_TASKS_KEEPALIVE_OPTIONS), opts?: { attemptTimeoutMs?: number; totalBudgetMs?: number; baseDelayMs?: number }); get(): Promise<CloudTasksClient>; call<T>(op: string, fn: (client: CloudTasksClient, callOptions: { timeout: number }) => Promise<T>): Promise<T> }`
  - `call` retries on codes 4 and 14 (after a single-flight rebuild) and on a bare INVALID_ARGUMENT (no rebuild; the existing `isBareInvalidArgument` moves here), until `totalBudgetMs` would be exceeded by the next attempt; then rethrows the last error unchanged. Any other error is rethrown at once.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** in `cloud-tasks-client.holder.spec.ts` (fake timers, a factory returning numbered fake clients with a `close: jest.fn()`):
  - `passes keepalive options to the client constructor`: default factory with `CloudTasksClient` mocked; `expect(CloudTasksClient).toHaveBeenCalledWith(CLOUD_TASKS_KEEPALIVE_OPTIONS)`.
  - `passes the per-attempt timeout to every call`: `fn` receives `{ timeout: 8000 }`.
  - `rebuilds the client and retries after UNAVAILABLE`: first `fn` call rejects `{code: 14}`, second resolves `'ok'`; result `'ok'`; factory called twice; first client's `close` called once; second call got client #2.
  - `rebuilds the client and retries after DEADLINE_EXCEEDED`: same with code 4.
  - `rebuilds once for concurrent failures`: three concurrent `call`s all reject 14 on client #1, then succeed; factory called exactly twice.
  - `gives up when the budget is spent and rethrows the last error`: `fn` always rejects `{code: 14}`; with `totalBudgetMs: 25000` the promise rejects with `{code: 14}` and total elapsed fake time ≤ 25000.
  - `does not retry ALREADY_EXISTS or NOT_FOUND`: codes 6 and 5 rejected once, rethrown, `fn` called once.
  - `retries a bare INVALID_ARGUMENT without rebuilding`: rejects `{code: 3, statusDetails: []}` then resolves; factory called once.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/service && yarn test src/modules/gcp-scheduling/cloud-tasks-client.holder.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `CloudTasksClientHolder`**. Backoff between attempts: `baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random())` with `baseDelayMs` 200 (INVALID_ARGUMENT keeps its 150 ms base and 3-attempt cap). Single-flight rebuild: keep `current: Promise<CloudTasksClient>` and `rebuilding: Promise<CloudTasksClient> | null`; a caller whose failed client is no longer `current` just retries on `current`. `close()` the old client with errors swallowed. Log `cloud-tasks-client-rebuilt` (`{ op, code }`) at warn and each retry at warn with `{ op, attempt, code, delayMs }`.

- [ ] **Step 4: Wire it into `GcpTaskSchedulerService`**: the constructor builds `this.clientHolder = new CloudTasksClientHolder()`; `getClient()` returns `this.clientHolder.get()` (path helpers keep using it); `createTask` replaces its own retry loop with `this.clientHolder.call('createTask', (c, o) => c.createTask({ parent, task }, o))`; `cancelJob`'s delete becomes `this.clientHolder.call('deleteTask', (c, o) => c.deleteTask({ name }, o))`. Keep the existing error mapping and diagnostics in `createTask`'s catch. In `gcp-task.scheduler.service.spec.ts`, `makeService` sets `(service as any).clientHolder = new CloudTasksClientHolder(() => fakeClient)`; rename the last test to `retries UNAVAILABLE and answers 503 once the budget is spent` and assert `createTask` was called more than once and status 503.

- [ ] **Step 5: Run the affected tests**

Run: `yarn test src/modules/gcp-scheduling`
Expected: PASS.

- [ ] **Step 6: Check google-gax forwards `grpc.*` options**: read `node_modules/google-gax/build/src/grpc.js` (`createStub`/channel options) and confirm keys starting with `grpc.` reach `@grpc/grpc-js`. If they do not, pass them the way gax documents (e.g. under `grpc` channel options) and adjust `CLOUD_TASKS_KEEPALIVE_OPTIONS`' use. Record what you found in one sentence in `.knowledge/subsystems/gcp-scheduling.md` (new pitfall "Dead channels"), along with: Cloud Run throttles CPU between requests, so pings only run during calls; Google front ends answer pings more often than they allow with GOAWAY `ENHANCE_YOUR_CALM` — 60 s is the floor to keep.

- [ ] **Step 7: Commit**

```bash
git add packages/service/src/modules/gcp-scheduling .knowledge/subsystems/gcp-scheduling.md
git commit -m "fix(service): rebuild the Cloud Tasks client and retry on DEADLINE_EXCEEDED/UNAVAILABLE, with keepalive"
```

### Task 2: Every task is named; ALREADY_EXISTS is success; caller idempotency key

**Files:**
- Create: `packages/service/src/modules/gcp-scheduling/task-name.ts`, `task-name.spec.ts`
- Modify: `packages/service/src/common/dto/schedule-request.dto.ts` (new `idempotencyKey`)
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` (`createTask`, `createRelayEndpointTask`, `createMetaEndpointTask`, `scheduleInternal`)
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.spec.ts`
- Modify: `.knowledge/subsystems/gcp-scheduling.md`, `.knowledge/conventions/api-contract.md`

**Interfaces:**
- Consumes: `CloudTasksClientHolder.call` (Task 1).
- Produces:
  - `export function taskNameFor(parts: string[]): string` — lowercase hex SHA-256 of `parts.join('\u0000')`, first 40 characters.
  - `ScheduleRequestDto.idempotencyKey?: string` (`@IsOptional() @IsString() @MaxLength(256)`; Swagger text: "Makes the request idempotent: a retry with the same key returns the same job id instead of creating a second task. Cloud Tasks refuses a name for about an hour after its task ran or was deleted, so use a new key for each task you want.").
  - `createTask(queueName, url, payload, scheduleTime: Date | undefined, taskName: string, timeoutSeconds?)` — `taskName` now required; returns `taskName`.
  - `createRelayEndpointTask(req, scheduleTime?, taskName?: string)` and `createMetaEndpointTask(ufid, req, scheduleTime, taskName?: string)` — when `taskName` is omitted they use `taskNameFor(['req', randomUUID()])`.

- [ ] **Step 1: Write the failing tests**
  - `task-name.spec.ts`: `is deterministic` (same parts → same name); `differs per part` (`['a','b']` vs `['ab']`); `uses only allowed characters and is 40 long` (`/^[0-9a-f]{40}$/`).
  - In `gcp-task.scheduler.service.spec.ts`:
    - `names every task`: `createTask` stub asserts `task.name` ends with `/tasks/<the given name>`.
    - `treats ALREADY_EXISTS as success and returns the name`: stub rejects `{code: 6, details: 'exists'}`; result is the given name; no HttpException.
    - `returns the same id when the keyed task already exists`: `scheduleJob({target, idempotencyKey: 'k', queue: 'jobs'})` twice where the second `createTask` rejects code 6; both return `taskNameFor(['key', 'jobs', 'k'])`.
    - `uses a fresh random name per request without a key`: two un-keyed `scheduleJob` calls produce different names.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test src/modules/gcp-scheduling/task-name.spec.ts src/modules/gcp-scheduling/gcp-task.scheduler.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** `createTask` always sets `task.name = await this.getTaskPath(queueName, taskName)`; in its catch, `error.code === 6` returns `taskName` (log at info `cloud-tasks-task-already-exists`). `scheduleInternal`'s direct-relay branch passes `request.idempotencyKey ? taskNameFor(['key', this.getQueueName(request.queue), request.idempotencyKey]) : undefined`. The meta branch is untouched here (N2 owns it). Update the comment above `INVALID_ARGUMENT_CODE` (tasks are now named). `.knowledge`: rewrite pitfalls "No idempotency tokens" and the INVALID_ARGUMENT sentence "tasks are created without a name"; fix "Redis" wording (prod uses Mongo via Keyv); api-contract gets `idempotencyKey`.

- [ ] **Step 4: Run the affected tests**

Run: `yarn test src/modules/gcp-scheduling src/common`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src .knowledge
git commit -m "fix(service): name every Cloud Task so retries cannot duplicate; accept an idempotency key"
```

### Task 3: SDK idempotency key and keyed network-error retry

**Files:**
- Modify: `packages/python-sdk/src/notitia/common_types.py` (`ScheduleRequest`)
- Modify: `packages/python-sdk/src/notitia/types.py` (`PreparedEventData`, if it mirrors request fields — add the same optional field) and `typed_client.py` (pass it through)
- Modify: `packages/python-sdk/src/notitia/low_level_client.py` (`_send_with_retries`, `send_schedule_request`)
- Test: `packages/python-sdk/tests/test_send_schedule_request_retry.py`
- Modify: `.knowledge/subsystems/python-sdk.md`, `packages/python-sdk/README.md` (one paragraph)

**Interfaces:**
- Consumes: service field `idempotencyKey` (Task 2).
- Produces: `ScheduleRequest.idempotency_key: Optional[str] = None`, sent on the wire as `idempotencyKey`; `LowLevelClient._send_with_retries(attempt_fn, *, retry_transport_errors: bool = False)`.

- [ ] **Step 1: Write the failing tests** (respx or the existing test's transport mock):
  - `test_idempotency_key_is_sent_camel_case`: body contains `"idempotencyKey": "k"` and no `idempotency_key`.
  - `test_keyed_request_retries_transport_errors`: first attempt raises `httpx.ConnectError`, second returns 202 `{"jobId": "j"}`; result `"j"`; two attempts.
  - `test_unkeyed_request_does_not_retry_transport_errors`: same first error, no key → `NotitiaError` after one attempt.
  - `test_keyed_transport_retries_stop_at_max_attempts`: always `httpx.ReadTimeout`, `RetryConfig(max_attempts=3)` → `NotitiaError` after 3 attempts.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/python-sdk && uv run pytest tests/test_send_schedule_request_retry.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `send_schedule_request`, rename the key after `asdict` (`filtered_data["idempotencyKey"] = filtered_data.pop("idempotency_key")` when present) and call `_send_with_retries(_attempt, retry_transport_errors=schedule_request.idempotency_key is not None)`. In `_send_with_retries`, when the flag is set, catch `httpx.TransportError` per attempt, sleep with `_compute_delay`'s exponential path (no response, so pass the attempt number), and re-raise on the last attempt. Bump `pyproject.toml` version to `1.3.0`.

- [ ] **Step 4: Run the SDK tests**

Run: `uv run pytest -q`
Expected: PASS (whole SDK suite; it is small).

- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk .knowledge/subsystems/python-sdk.md
git commit -m "feat(sdk): idempotency_key on schedule requests; retry network errors when keyed"
```

### N1 finish

- [ ] Run the full service suite and build: `cd packages/service && yarn test && yarn build` — expected: all pass, build succeeds.
- [ ] Push `fix/cloud-tasks-reliability` and open a PR against `main` with `gh pr create` (body: incident summary, what changed, the gax-forwarding finding from Task 1 Step 6, link to the spec). Do not merge.

---

## Part N2 — recurring correctness (branch `fix/recurring-schedules`, from N1's head)

- [ ] `git switch -c fix/recurring-schedules` from `fix/cloud-tasks-reliability` after Task 3.

### Task 4: Time zones and RRULE anchoring in the schedule helper

**Files:**
- Modify: `packages/service/src/common/services/schedule.helper.service.ts`
- Create: `packages/service/src/common/services/schedule.helper.service.spec.ts`
- Create: `packages/service/src/common/dto/is-iana-time-zone.validator.ts`
- Modify: `packages/service/src/common/dto/schedule-request.dto.ts` (`RecurringScheduleDto.timezone`)
- Modify: `.knowledge/conventions/api-contract.md`

**Interfaces:**
- Produces:
  - `RecurringScheduleDto.timezone?: string` validated by `@IsIanaTimeZone()` (valid iff `new Intl.DateTimeFormat('en-US', { timeZone: value })` does not throw).
  - `calculateNextOccurrence(scheduleString: string, fromDate: Date, options?: { inclusive?: boolean; timezone?: string }): Date | null` (replaces the positional `inclusive`; update the in-memory scheduler's two call sites).
  - `normalizeRecurringSchedule(scheduleString: string, timezone: string | undefined, now: Date): string` — cron: returned unchanged. RRULE without DTSTART: returns `DTSTART;TZID=<timezone ?? 'UTC'>:<now in that zone, YYYYMMDDTHHMMSS>\nRRULE:...`. RRULE with DTSTART whose TZID differs from a given `timezone`: throws `BadRequestException('schedule DTSTART time zone <x> differs from timezone <y>')`.
- Cron uses cron-parser's `tz` option (`timezone ?? 'UTC'`).

- [ ] **Step 1: Write the failing tests** in `schedule.helper.service.spec.ts`:
  - `cron keeps local time across DST`: `'0 21 * * *'`, `timezone: 'Europe/Rome'`; from `2026-10-24T12:00:00Z` → `2026-10-24T19:00:00.000Z`; from `2026-10-26T12:00:00Z` → `2026-10-26T20:00:00.000Z`.
  - `cron without a timezone is UTC`: `'0 21 * * *'` from `2026-10-24T12:00:00Z` → `2026-10-24T21:00:00.000Z`, independent of `process.env.TZ`.
  - `rrule with a TZID dtstart keeps local time across DST`: `DTSTART;TZID=Europe/Rome:20261020T210000\nRRULE:FREQ=DAILY` from `2026-10-26T12:00:00Z` → `2026-10-26T20:00:00.000Z`.
  - `anchors an rrule without dtstart once`: `normalizeRecurringSchedule('RRULE:FREQ=HOURLY;INTERVAL=6', 'Europe/Rome', new Date('2026-11-16T10:15:42.500Z'))` → contains `DTSTART;TZID=Europe/Rome:20261116T111542`; next occurrences after `2026-11-16T12:00:00Z` → `2026-11-16T16:15:42.000Z`.
  - `rejects a dtstart time zone that differs from timezone`: throws BadRequestException.
  - `leaves cron unchanged when normalizing`.
  - DTO: `rejects an unknown time zone` (class-validator `validate` on a `RecurringScheduleDto` with `timezone: 'Mars/Base'` → one error).

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test src/common/services/schedule.helper.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the signatures above. For the RRULE path keep `RRule.fromString`; a DTSTART with TZID is handled by rrule itself (verified behaviour, spec §3.5); remove the `dtstart || fromDate` fallback for normalized rules (an un-normalized rule without DTSTART can only come from a pre-N2 meta payload: keep the old fallback for that case only). api-contract: document `timezone` and the anchoring.

- [ ] **Step 4: Run the affected tests**

Run: `yarn test src/common src/modules/in-memory-scheduling`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common packages/service/src/modules/in-memory-scheduling .knowledge/conventions/api-contract.md
git commit -m "feat(service): IANA timezone on recurring schedules; anchor an RRULE without DTSTART at creation"
```

### Task 5: Occurrence on the meta payload and the X-Notitia-Occurrence header

**Files:**
- Modify: `packages/service/src/common/constants.ts` (header constants)
- Modify: `packages/service/src/modules/gcp-scheduling/dto/gcp-meta-task-payload.dto.ts`
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` (`scheduleInternal`: normalize the schedule, put `occurrence` on the meta payload, add the header on scheduled direct relays)
- Modify: `packages/service/src/modules/in-memory-scheduling/in-memory.scheduler.service.ts`
- Create: `packages/service/src/modules/in-memory-scheduling/in-memory.scheduler.service.spec.ts`
- Modify: `.knowledge/subsystems/in-memory-scheduling.md`

**Interfaces:**
- Produces: `NOTITIA_TASK_ID_HEADER = 'X-Notitia-Task-ID'`, `NOTITIA_OCCURRENCE_HEADER = 'X-Notitia-Occurrence'` in `common/constants.ts`; meta payload field `occurrence: string` (ISO-8601 UTC of the occurrence `T` the task serves; `isOccurrence` stays for old readers).
- `scheduleInternal` runs `normalizeRecurringSchedule` once for recurring requests and stores the result in the request it sends onward, so every hop carries the anchored rule and `timezone`.

- [ ] **Step 1: Write the failing tests**
  - GCP spec: `a scheduled direct relay carries X-Notitia-Occurrence`: `scheduleJob` with `{type: 'on', time: '2026-12-01T09:00:00Z'}` → relay payload headers include `X-Notitia-Occurrence: '2026-12-01T09:00:00.000Z'`; an immediate request has no such header.
  - GCP spec: `a recurring create sends occurrence and the anchored rule on the meta payload`.
  - In-memory spec (fake timers, `HttpExecutorService` mocked): `recurring fires carry task id and occurrence headers` — `'*/5 * * * *'` from `2026-11-16T10:02:00Z`: first execution headers `X-Notitia-Task-ID: <jobId>` and `X-Notitia-Occurrence: '2026-11-16T10:05:00.000Z'`; `in-memory recurring honours timezone` (cron `'0 21 * * *'`, `Europe/Rome`, fires at 20:00Z on 2026-11-16).

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test src/modules/gcp-scheduling/gcp-task.scheduler.service.spec.ts src/modules/in-memory-scheduling`
Expected: FAIL.

- [ ] **Step 3: Implement.** In-memory: compute occurrences with the request's `timezone`, pass the occurrence `Date` into `executeJob` and merge both headers into `request.headers` for that execution (task id = the recurring `jobId`, not the `jobId-<ms>` suffix it uses today for its executor log id).

- [ ] **Step 4: Run the affected tests** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src .knowledge/subsystems/in-memory-scheduling.md
git commit -m "feat(service): X-Notitia-Occurrence on scheduled relays; occurrence on meta payloads"
```

### Task 6: Fork-free recurring chain in MetaService

**Files:**
- Modify: `packages/service/src/modules/gcp-scheduling/meta.service.ts` (rewrite `processMetaJob`)
- Modify: `packages/service/src/modules/gcp-scheduling/meta.controller.ts` (pass `x-cloudtasks-taskname` and `x-cloudtasks-tasketa` through)
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` (`scheduleInternal` meta branch: initial meta name)
- Create: `packages/service/src/modules/gcp-scheduling/meta.service.spec.ts`
- Modify: `.knowledge/subsystems/gcp-scheduling.md`

**Interfaces:**
- Consumes: `taskNameFor` (Task 2), `createRelayEndpointTask(req, scheduleTime?, taskName?)`, `createMetaEndpointTask(ufid, req, scheduleTime, taskName?)`, `calculateNextOccurrence(..., { timezone })` (Task 4), meta `occurrence` (Task 5), `isTombstoned(ufid)` (Task 7 — until Task 7 lands, stub it as `async () => false` in the service).
- Produces: `processMetaJob(ufid: string, payload: GcpMetaTaskPayload, delivery: { taskName: string; etaSeconds?: number }): Promise<void>`; names `taskNameFor([ufid, 'meta', T])`, `taskNameFor([ufid, 'relay', T])`, `taskNameFor([ufid, 'hop', T, delivery.taskName])`, initial meta of a create `taskNameFor([ufid, 'create'])`.
- Order per delivery (spec §6.4): tombstone check → hop if `T` > now + 30 days → relay for `T` → successor `S` (spec §6.5: `after(T)`, or `after(now)` if that is past) → meta for `S` unless the rule ended (then delete the tracked id) → best-effort tracked-id write. `T` comes from `payload.occurrence`, else from `delivery.etaSeconds`.
- The "UFID not found in cache" early return is removed.

- [ ] **Step 1: Write the failing tests** in `meta.service.spec.ts` (scheduler mocked; capture names):
  - `relays the occurrence and schedules the next one by name`: hourly cron, `T = 10:00Z`, now `10:00:05Z` → relay named `relay,T` with header occurrence `T`; meta named `meta,11:00Z` scheduled at `11:00Z`.
  - `a replayed delivery creates the same names`: run twice (second create calls reject code 6 → treated as success by `createTask`; here assert identical names were requested).
  - `a late retry converges on the next shared occurrence`: every-5-minutes cron. Delivery for `T = 10:00Z` processed at `10:12Z` → relay for `10:00Z`, next meta for `10:15Z` (skip-ahead). Delivery for `T = 10:05Z` (the fork an earlier attempt at `10:03Z` would have created) processed at `10:12Z` → next meta also for `10:15Z`: assert both requested the same meta name.
  - `does not stop when the tracked id is missing`: cache empty → still relays and reschedules.
  - `ends the chain when the rule has no more occurrences`: `RRULE` with `COUNT=1` anchored → no next meta; tracked id deleted.
  - `hops without relaying when the occurrence is beyond 30 days`.
  - `takes the occurrence from the task ETA for a v1.3.4 payload`: payload without `occurrence`, `etaSeconds = 1763287200` → relay header `2025-11-16T10:00:00.000Z`.
  - `a tracked-id write failure does not fail the delivery`.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test src/modules/gcp-scheduling/meta.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Long one-off meta chains (`schedule.type === 'on'`) follow the same steps with no successor. Update the knowledge page's invariants (chain identity, missed-occurrence rule, no stale check).

- [ ] **Step 4: Run the affected tests**

Run: `yarn test src/modules/gcp-scheduling`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/modules/gcp-scheduling .knowledge/subsystems/gcp-scheduling.md
git commit -m "fix(service): name meta and relay tasks by occurrence so a recurring chain cannot fork"
```

### Task 7: Cancel by tombstone, one cache-key form, keyed schedule ids

**Files:**
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.ts` (`getCacheKeyForJob`, `getIdFromUfid`, `setIdForUfid`, `delUfid`, new tombstone methods, `cancelJob`, `scheduleInternal` meta branch)
- Modify: `packages/service/src/modules/gcp-scheduling/meta.service.ts` (replace the Task 6 stub with `isTombstoned`)
- Modify: `packages/service/src/modules/gcp-scheduling/gcp-task.scheduler.service.spec.ts`, `meta.service.spec.ts`
- Modify: `.knowledge/subsystems/gcp-scheduling.md`, `.knowledge/conventions/api-contract.md`

**Interfaces:**
- Produces: cache keys `gcp_job:<ufid>` (tracked meta task name) and `gcp_job:cancelled:<ufid>` (tombstone, TTL `60 * 24 * 3600 * 1000` ms); `tombstone(ufid): Promise<void>`, `isTombstoned(ufid): Promise<boolean>`; `getIdFromUfid(ufid, queueName?)` reads the new key, then the old `gcp_job:<queueName>:<ufid>` and `gcp_job:<default>:<ufid>` forms; `deriveUfid(key: string, queue: string): string` — 19 decimal digits from the SHA-256 of `['ufid', queue, key]` (keeps today's ufid shape).
- `cancelJob(id, queue?)`: known ufid → tombstone, best-effort `deleteTask` of the tracked meta task (NOT_FOUND ignored), delete tracked key(s), return `true`; else the existing direct-task path.
- `scheduleInternal` meta branch: `ufid = idempotencyKey ? deriveUfid(key, queue) : generateNumericId()`; if keyed and tombstoned → `throw new ConflictException('A schedule with this idempotency key was cancelled; use a new key')`; initial meta named `taskNameFor([ufid, 'create'])`; ALREADY_EXISTS → returns the same ufid.

- [ ] **Step 1: Write the failing tests**
  - `cancel without queue stops a jobs-queue schedule`: create with `queue: 'jobs'`, `cancelJob(ufid)` → tombstone written; then `processMetaJob` for its first occurrence relays nothing and creates no next meta.
  - `cancel reads a tracked id stored by v1.3.4`: cache has `gcp_job:jobs:<ufid>` only → `deleteTask` called on `meta-jobs/<id>`; returns true.
  - `a cancel during a delivery stops the next occurrence`: tombstone written after the relay step (mock hook) → that delivery's relay goes out, the following delivery relays nothing.
  - `a keyed create retried returns the same schedule id`: two creates with key `k` → same ufid; second meta create got code 6.
  - `a keyed create after cancel is refused with 409`.
  - `cancel of an unknown id falls back to the direct task path` (existing behaviour kept).

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test src/modules/gcp-scheduling`
Expected: FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. Keyv TTL: `cacheManager.set(key, value, ttlMs)`.

- [ ] **Step 4: Run the affected tests** (same command). Expected: PASS.

- [ ] **Step 5: Before committing, size the transition** (read-only): ask the user to run, or run if they provide the connection, a count of `gcp_job:` keys in the prod Mongo `cache` collection (`db.cache.countDocuments({ key: /^gcp_job:/ })` — check the Keyv Mongo document shape first). Record the number in the PR body. Do not write to prod.

- [ ] **Step 6: Commit**

```bash
git add packages/service/src/modules/gcp-scheduling .knowledge
git commit -m "fix(service): cancel recurring schedules by tombstone, with one cache key form and keyed schedule ids"
```

### Task 8: SDK time zone and occurrence header

**Files:**
- Modify: `packages/python-sdk/src/notitia/common_types.py` (`RecurringSchedule.timezone`), `src/notitia/__init__.py` (export the constants)
- Test: `packages/python-sdk/tests/test_recurring_schedule.py` (create)
- Modify: `.knowledge/subsystems/python-sdk.md`, `packages/python-sdk/README.md`

**Interfaces:**
- Produces: `RecurringSchedule(schedule: str, timezone: Optional[str] = None)`; `NOTITIA_TASK_ID_HEADER = "X-Notitia-Task-ID"`, `NOTITIA_OCCURRENCE_HEADER = "X-Notitia-Occurrence"` exported from `notitia`.

- [ ] **Step 1: Write the failing tests**: `test_timezone_is_sent` (body `schedule` has `"timezone": "Europe/Rome"`); `test_timezone_omitted_when_none`; `test_header_constants_exported`.
- [ ] **Step 2: Run to verify they fail**: `uv run pytest tests/test_recurring_schedule.py -q` → FAIL. Note: `RecurringSchedule`'s dataclass field order puts `type` with `init=False` last; add `timezone` before it as a defaulted field.
- [ ] **Step 3: Implement**; README: a short "Recurring schedules" section (time zone, idempotency key per schedule version, reading the two headers to build a dedupe key). Bump SDK version to `1.4.0` if N1's `1.3.0` is already released, else leave `1.3.0`.
- [ ] **Step 4: Run the SDK suite**: `uv run pytest -q` → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/python-sdk .knowledge/subsystems/python-sdk.md
git commit -m "feat(sdk): timezone on recurring schedules; export Notitia header names"
```

### N2 finish

- [ ] Full suites: `cd packages/service && yarn test && yarn build`; `cd packages/python-sdk && uv run pytest -q` — all pass.
- [ ] Push `fix/recurring-schedules` and open a PR. Base: `fix/cloud-tasks-reliability` while N1 is open (retarget to `main` once N1 merges). Body: what D3 must do (key per schedule version; dedupe on `X-Notitia-Task-ID` + `X-Notitia-Occurrence`), the transition count from Task 7 Step 5, link to the spec. Do not merge.
