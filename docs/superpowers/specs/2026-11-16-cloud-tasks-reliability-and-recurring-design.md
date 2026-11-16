# Notitia: Cloud Tasks reliability and correct recurring schedules (plus the Spectral backend rescue)

**Date:** 2026-11-16
**Status:** Draft (brainstorming, builder-checked), awaiting owner approval
**Repos:** `Valahaar/notitia` (service + Python SDK), `principled-intelligence/spectral-backend`
**Owner rulings in this conversation:** marked **[owner]**. Calls made by the designer, open to correction, are marked **[call]**.

## 1. Why

Two reasons, one piece of work.

1. **The 2026-11-10 incident.** At 01:53:56 UTC the last conversation of an eval finished and the backend tried to
   dispatch `finalize_attack` (job `6af3c8605c996316ee708a3d`) through Notitia. Notitia answered 504 five times
   between 01:54:16 and 01:55:41; the backend logged `notitia-defer-failed` and `job-dispatch-abandoned`. Nothing
   retries an abandoned dispatch, so the eval stayed "running" until someone noticed.
   - The five 504s came about 20 s apart, which is the Cloud Tasks `createTask` default deadline: each call hung on
     a dead gRPC channel for its whole deadline and Notitia mapped `DEADLINE_EXCEEDED` to 504. Notitia runs on Cloud
     Run with CPU throttled outside requests and all egress through the VPC, the usual setting for idle connections
     being dropped silently. Every later call reused the same dead channel.
   - Notitia names no task (`hasName: false`), so it cannot safely retry an ambiguous failure, and neither can the
     SDK.
2. **Sampling D3** (recurring evaluation-policy schedules) will be the first recurring use of Notitia: a saved policy
   carries a schedule, created as a Notitia `RecurringSchedule`; editing a schedule cancels the Notitia job, creates
   a new one, and stores the new id on the backend's schedule document. Notitia v1.3.4's recurring path is not
   correct enough for that (§3). The D2 spec's "D3 readiness" section also needs two things Notitia lacks: a run
   idempotency key ("a schedule firing twice gives one run"), which needs an occurrence identity on each fire, and
   IANA time zones (D2 windows are `"between 13:00 and 17:00 Europe/Rome"`, so a schedule is "21:00 Europe/Rome").

## 2. Goals, non-goals, anti-goals

**Goals**

- A dead Cloud Tasks connection costs one short attempt, not minutes: detected, replaced, retried.
- No Notitia retry, and no SDK retry that carries a caller key, can create a duplicate task.
- A recurring schedule fires each occurrence at most once per Cloud Tasks dedup window, never forks into two
  chains, and stops for good when cancelled (at most the occurrence already being processed still goes out).
- Each recurring fire tells the consumer which occurrence it is, so the consumer can dedupe exactly.
- Schedules run in a stated IANA time zone, correct across DST.
- In the backend: a dependent whose dispatch was abandoned is dispatched again without a sweep, and a short Notitia
  outage no longer abandons dispatches at all.

**Non-goals**

- Infrastructure changes (queue retry limits, minimum instance count). **[owner]** Not in these PRs; see §10.
- `GET /schedule/{id}` (status, next fire time). **[call]** D3 keeps its own schedule document and the backend
  does not poll (the 2026-11-11 "no polling / no cron / no sweep" ruling), so nothing needs it yet.
- A schedules collection in Notitia (approach 3 in §4.2).
- Backfilling every occurrence missed during an outage (see §6.5).
- The D3 feature itself (being specified in another session).

**Anti-goals** (would make this a failure even if it works)

- A sweep, cron or poller in the backend (contradicts the 2026-11-11 ruling).
- A fix that makes duplicate deliveries more likely: every retry added here must be made idempotent by a name first.
- Changing behaviour that #530's reviewers already signed off on outside the watchdog's terminal branch.

## 3. What is wrong today (Notitia v1.3.4, verified against source on 2026-11-16)

Files: `packages/service/src/modules/gcp-scheduling/{gcp-task.scheduler.service.ts, meta.service.ts,
meta.controller.ts}`, `src/common/services/schedule.helper.service.ts`,
`src/modules/job-scheduling/job-scheduling.controller.ts`.

1. **Cache-key queue mismatch.** `scheduleInternal` stores ufid → meta task id under `gcp_job:<request.queue>:<ufid>`.
   `processMetaJob` re-stores it after a reschedule without the queue (default-queue key, `gcp_job:notitia:<ufid>` in
   prod, where `GCP_JOB_QUEUE_NAME=notitia` but the backend uses queue `jobs`). `cancelJob` and `delUfid` read and
   delete without the queue. Result: cancelling a recurring job before its first fire is a no-op and the chain keeps
   firing; after the first fire it works only by accident.
2. **Chain fork.** The meta "stale" check only tests that a cache entry exists, never that the delivering task is the
   tracked one. If creating the next meta task succeeds and the cache write fails, the Cloud Tasks retry creates a
   second chain; both fire forever and a cancel stops one. `processMetaJob` also creates the occurrence's relay
   before the next meta task, so any failure after the relay re-fires the occurrence on retry. The successor is
   computed from "now", so two attempts of one delivery can pick different successors.
3. **Cancel vs in-flight fire.** A cancel landing while `processMetaJob` runs is undone: it writes the cache entry
   back after rescheduling.
4. **Every fire looks the same.** The relay carries `X-Notitia-Task-ID: <ufid>`, but nothing names the occurrence.
5. **Time zones.** Cron is parsed with no `tz`, so `0 21 * * *` is 21:00 UTC (23:00 CEST, then 22:00 CET).
   `DTSTART;TZID=Europe/Rome:…` with `RRULE:FREQ=DAILY` stays at 21:00 local across DST (verified with rrule@2.8.1
   under TZ=UTC across 2026-10-25). cron-parser's own `tz` option is also correct. An RRULE without DTSTART anchors
   at each fire's processing time, so "every 6 hours" drifts by delivery latency and carries odd seconds.
6. **No task names.** `createTask` never sets `task.name`, so a retried create can duplicate. That is also why the
   bare-`INVALID_ARGUMENT` retry is the only retry Notitia allows itself today.

Infra facts that bound the design (cloud-infrastructure `terraform/modules/ghost/`, not changed here): queues `jobs`
and `meta-jobs`; retry `max_attempts = 3`, `min_backoff = 300s`, `max_backoff = 3600s`, `max_retry_duration =
86400s`, so a failing task gets about 35 minutes; Notitia `min_instance_count = 1 # TODO`, max 2 in production.

## 4. Approaches

### 4.1 Backend rescue of an abandoned dispatch

| | Approach | Trade-off |
|---|---|---|
| **A** | When release B's per-job watchdog fires on a **terminal** job, dispatch that job's dependents that are pending, unlocked and never dispatched; if a dispatch fails, the watchdog fails and Cloud Tasks redelivers it. | Per-job, armed before the risk: fits the no-sweep ruling. Needs release B's watchdogs, so it ships with #530. Window = the jobs queue's redelivery budget (about 35 min today). |
| B | A periodic sweep for stranded dependents. | Covers everything, but reverses the 2026-11-11 ruling and adds a cron. |
| C | Retry the Notitia call longer (about 10 min) before abandoning. | Ships on `main` now; any longer outage still strands. |

**Chosen [owner]: A, committed inside draft #530 (not a stacked PR), plus C as a separate small PR on `main` as the
stopgap until B is deployed.**

### 4.2 Recurring-schedule correctness in Notitia

| | Approach | Trade-off |
|---|---|---|
| **1** | Deterministic task names from (schedule id, occurrence time) for meta and relay tasks; a cancel writes a tombstone that every meta delivery checks before relaying; one queue-independent cache key. | No compare-and-set needed, so the Keyv cache (Mongo or Redis) stays. A cancel during an in-flight fire lets that one occurrence go out. |
| 2 | Keep the tracked-id model; add compare-and-set and drop deliveries whose task name is not the tracked one. | Keyv has no compare-and-set: needs a direct Mongo collection (and a Redis twin). More parts, same guarantees. |
| 3 | A real schedules collection (status, next fire, current task). | Largest change; brings `GET /schedule/{id}`, which nothing needs yet. |

**Chosen [owner]: 1.**

## 5. Deliverables and order

| # | Repo / branch | Content | Depends on |
|---|---|---|---|
| N1 | notitia `fix/cloud-tasks-reliability` | Reliability (§6.1–6.3) + SDK idempotency key | — |
| N2 | notitia, branch off N1 or `main` after N1 merges | Recurring correctness (§6.4–6.7) + SDK time zone and occurrence | N1 (task naming, retry helper) |
| B-A | spectral-backend, new commit(s) on `feat/jobkit-lock-watchdogs` (draft #530) | Watchdog re-triggers dependents (§7.1) | — (lands with #530) |
| B-C | spectral-backend, new branch off `main` | Longer Notitia retry (§7.2) | — |

**[owner]** Two Notitia PRs: N1 first (incident), N2 second (D3). N1 and B-C are independent and can deploy in any
order. Service release N1 → v1.3.5 or v1.4.0 and SDK → v1.3.0 are for the release step, not this design.

## 6. Notitia design

### 6.1 Keepalive and client rebuild (N1)

- Build `CloudTasksClient` with gRPC keepalive channel options (`grpc.keepalive_time_ms`,
  `grpc.keepalive_timeout_ms`, `grpc.keepalive_permit_without_calls`), so a dead transport under an active call is
  detected within `time + timeout` and fails `UNAVAILABLE` instead of hanging. **[call]** Start around 60 s / 10 s;
  the builder must check that Google's front end accepts that ping rate (too-frequent pings get `GOAWAY
  ENHANCE_YOUR_CALM`) and that google-gax forwards `grpc.*` options to the channel.
- Every Cloud Tasks call (`createTask`, `deleteTask`) goes through one helper that:
  - sets a short per-attempt deadline (**[call]** about 8 s; gax's default for `createTask` is 20 s);
  - on `DEADLINE_EXCEEDED` (4) or `UNAVAILABLE` (14) closes the client and builds a new one (single-flight: concurrent
    callers share one rebuild), then retries with jittered exponential backoff;
  - keeps the whole retry within a total budget below the callers' HTTP timeout (**[call]** about 25 s; the backend
    calls Notitia with a 30 s client timeout);
  - keeps the existing bare-`INVALID_ARGUMENT` retry;
  - on a retried `createTask` that gets `ALREADY_EXISTS` (6), treats it as success and returns the task's name (the
    earlier attempt landed). This is only safe because of §6.2.
- Logs: one event per rebuild (`cloud-tasks-client-rebuilt`, with the triggering code) and per retry.

### 6.2 Every task is named (N1)

- `createTask` always sets `task.name`. Name characters `[A-Za-z0-9_-]`, at most 500. Names must not be sequential
  or time-prefixed (Cloud Tasks hot-spots on sequential names), so a name is a hash (for example SHA-256 hex,
  truncated) with an optional short readable suffix.
- Name sources:
  - a request with an `idempotencyKey` (new optional field on `ScheduleRequestDto`): hash of
    (`idempotencyKey`, target queue). A retry of the same request by the caller then hits `ALREADY_EXISTS` and gets
    the same job id back (with the same `202` response shape as today);
  - otherwise: a random id generated once per incoming request, so Notitia's own retries (§6.1) are idempotent;
  - meta and relay tasks of a recurring schedule or a long one-off: §6.4.
- Cloud Tasks refuses a name for about 1 hour after a task of that name was executed or deleted (queues created by
  the Cloud Tasks API). Callers must therefore use a fresh key for a task they really want twice; document it on
  the field.
- The id returned for a direct task stays "the last path segment of the task name", now the name we chose.
- SDK (N1): `ScheduleRequest.idempotency_key: Optional[str]`, sent as `idempotencyKey`. **[call]** When a key is set,
  the SDK also retries network errors (`httpx.TransportError`, timeouts) with the existing backoff, since a retry can
  no longer duplicate; without a key, behaviour is unchanged.

### 6.3 Knowledge (N1)

Update `.knowledge/subsystems/gcp-scheduling.md` ("No idempotency tokens", the INVALID_ARGUMENT pitfall's "tasks
are created without a name", the Redis wording: the prod store is Mongo through Keyv) and
`.knowledge/subsystems/python-sdk.md`.

### 6.4 Recurring chain identity (N2)

- Every meta payload carries the occurrence it is for: `occurrence` (ISO-8601 UTC, the occurrence's scheduled
  time `T`) alongside the existing request. A meta task for `T` that is an intermediate 30-day hop carries the same
  `T`.
- Names:
  - meta task that fires at `T` (final hop): `hash(ufid, "meta", T)`;
  - relay task for occurrence `T`: `hash(ufid, "relay", T)`;
  - intermediate 30-day hops: any name that is stable across retries of the same delivery (for example
    `hash(ufid, "hop", T, deliveringTaskName)`); their forks converge at `T` anyway.
- A delivery of the meta task for `T`, in order:
  1. if the schedule is tombstoned (§6.6): log, clear the tracked id, return 200 (chain ends);
  2. if `T` is still more than 30 days away: create the next hop and return;
  3. create the relay for `T` (immediate), named as above; `ALREADY_EXISTS` = already done;
  4. compute the successor `S` (§6.5) and, unless the rule has ended, create the meta task for `S`; `ALREADY_EXISTS`
     = already done;
  5. best-effort write of the tracked meta task id (for eager delete on cancel); a failed write is logged and does
     not fail the delivery.
- Why this cannot fork: every task's name is a function of the occurrence it serves, so two chains that ever compute
  the same occurrence collide on `ALREADY_EXISTS` and merge, and a relay for one occurrence can be created only once
  per dedup window. The relay-before-next-meta order no longer matters, because a retry re-creates both by name.
- The "UFID not found in cache → stale" check is removed: a missing tracked id is no longer a stop signal (it would
  silently kill a schedule whose cache write failed). The tombstone is the only stop signal.

### 6.5 Successor and missed occurrences (N2)

- `S = rule.after(T)`. If `S` is already in the past when computed (the delivery was late by more than one period),
  skip ahead: `S = rule.after(now)`.
- So after an outage the first missed occurrence fires once, late, carrying its own `T`; the other missed ones are
  skipped; the schedule resumes on time. **[call]** This suits D3: a policy window is resolved at run time, so one
  late run covers the gap, and a burst of catch-up runs would spend budget for nothing.
- Two attempts of the same delivery that straddle an occurrence can compute different `S`; the resulting chains
  converge on their next shared occurrence (§6.4), at the cost of at most one extra late relay for a distinct
  occurrence, which the consumer sees as a different `X-Notitia-Occurrence`.

### 6.6 Cancel (N2)

- One cache key form, independent of queue: `gcp_job:<ufid>` for the tracked id and `gcp_job:cancelled:<ufid>` for
  the tombstone. The queue a schedule uses lives in its meta payload. `cancelJob` works with or without the `queue`
  query parameter.
- `cancelJob(id)`: if `id` is a known ufid (tracked id present, or found under the old `gcp_job:<queue>:<ufid>`
  form for both the request queue and the default queue): write the tombstone (TTL **[call]** 60 days: longer than a
  30-day hop plus the meta queue's retry window), then best-effort `deleteTask` on the tracked meta task, then
  return `true`. Otherwise treat `id` as a direct task id as today.
- A cancel that lands during a delivery: the delivery may still create the relay for its `T` and the meta task for
  `S`; the `S` delivery finds the tombstone and ends the chain without relaying. So at most the occurrence already
  being processed goes out.
- D3's "edit = cancel + create new" works unchanged: the new schedule has a new ufid, so no name collides.
- A caller `idempotencyKey` on a recurring or long one-off request derives the ufid (hash of the key) instead of a
  random one, so a retried create returns the same schedule instead of starting a second one. **[call]**
- A create whose key derives a ufid that is already tombstoned answers **409** ("schedule with this key was
  cancelled; use a new key") instead of 202, so a reused key can never yield a schedule that silently never runs.
  **[call]** Keys are therefore per schedule version, documented on the field; D3 must build its key from its
  schedule document id plus an edit counter (or the schedule version's own id), not from the document id alone.
- Transition: tracked ids written by v1.3.4 under `gcp_job:<queue>:<ufid>` are read as a fallback by cancel; meta
  payloads from v1.3.4 that lack `occurrence` take `T` from the `X-CloudTasks-TaskETA` header of the delivering
  task. The builder should check the prod Mongo `cache` collection for live `gcp_job:` entries to size this (the
  backend only uses one-off schedules today, so there may be none).

### 6.7 Time zones, RRULE anchoring, occurrence header (N2)

- `RecurringScheduleDto.timezone?: string`, an IANA name, validated at the API (400 if unknown). Absent = UTC
  (today's behaviour in prod, which runs in UTC; now stated instead of depending on the server's `TZ`).
- Cron: parsed with cron-parser's `tz` option.
- RRULE: if the rule has no DTSTART, it is anchored once, at creation: `DTSTART;TZID=<timezone>:<creation time, to
  the second>` is written into the stored schedule string that all later meta payloads carry, so "every 6 hours"
  no longer drifts. A rule whose DTSTART has a TZID different from `timezone` → 400.
- `ScheduleHelperService` takes the time zone, so the in-memory scheduler gets the same behaviour for local dev.
- Every relay for a scheduled occurrence (recurring or long one-off) sends `X-Notitia-Occurrence: <T as ISO-8601
  UTC>`, next to the existing `X-Notitia-Task-ID: <ufid>`; the in-memory scheduler does the same. **[call]** Direct
  one-off tasks with a schedule time send it too (their `T` is known at create), immediate ones do not.
- SDK (N2): `RecurringSchedule(schedule, timezone=None)`; a constant for the header name
  (`NOTITIA_OCCURRENCE_HEADER`). D3 builds its run idempotency key from (`X-Notitia-Task-ID`,
  `X-Notitia-Occurrence`).
- Knowledge: `gcp-scheduling.md` (chain identity, tombstone, missed occurrences), `in-memory-scheduling.md`,
  `python-sdk.md`, `conventions/api-contract.md` (new fields and header).

## 7. Spectral backend design

### 7.1 B-A: the watchdog re-triggers dependents (inside #530)

Where: `packages/jobs/src/jobkit/runner.py` on `feat/jobkit-lock-watchdogs`, workspace
`job-workflows-system` (`/home/nick/principled/.orchard-worktrees/job-workflows-system/spectral-backend`).

- In `JobRunner.watchdog`, the terminal branch, today `return "ended"`, first dispatches the job's dependents that
  are: `depends_on` this job, `locked_by` null, last step `pending`, and `dispatched_at` null. The query adds
  `dispatched_at: None` to `_trigger_dependents`' filter **for this path only** (the normal completion path is
  unchanged). In the usual case the first dispatch succeeded, the query matches nothing, and the watchdog makes no
  Notitia call.
- It reuses `_trigger_dependents`' logic: `_check_dependencies` per dependent; not ready → skipped, no call; failed
  dependency → deferred directly; ready → `_dispatch_up_to_capacity` (phase-1 admission first, so nothing is
  dispatched only to park).
- If any dispatch fails, the watchdog raises, so `POST /internal/jobs/{id}/watchdog` answers 5xx and Cloud Tasks
  redelivers the same token; the next delivery finds the job still terminal and retries. `_safe_dispatch` already
  returns a bool; `_dispatch_up_to_capacity` and the shared helper need to report failure to this caller.
  **[call]** Raise on any failure, scoped or not. A scoped dependent already has a backstop, so raising there is
  redundant but harmless, and one rule is simpler.
- What this covers: `FinalizeAttackJob` (`builders/attack.py:1343`) declares no `concurrency_scopes`, so it is an
  unscoped legacy-graph dependent with no backstop, exactly the incident's case. It also closes spec §5.4's "known
  residual gap" (a crash between a dependency's terminal write and `_trigger_dependents`).
- Window: the jobs queue's redelivery budget (about 35 min at 3 attempts today). Release B's pre-deploy gate item 2
  already asks for that budget to be checked; this makes the check matter for dependents too.
- Docs in the same commit: `watchdog` docstring; durable-execution spec §5.2/§5.4 (campaign
  `.superpowers/campaigns/2026-11-11-durable-execution/`); tracker (release B scope line and gate); knowledge
  `architecture/jobs/job-system-parking.md` (the recovery gap) and `job-runner-lifecycle.md`; the #530 PR body.
- Tests: terminal job with an undispatched ready dependent → dispatched, outcome `"ended"`; dependent with
  `dispatched_at` set → no transport call; not-ready dependent → untouched; failed-dependency dependent → deferred;
  transport failure → watchdog raises and records nothing; a scoped dependent goes through admission.
- Then rebase the two unpushed local branches stacked on #530, `feat/jobkit-durable-core` and
  `feat/jobkit-durable-hardening`. Expected conflict: durable-core's terminal branch calls `_on_terminal(job)` and
  its docstring says "dependents are not re-triggered here"; the merged branch calls `_on_terminal(job)` then the
  re-trigger, and the docstring says so. Run the affected tests on each rebased branch. Check the workspace's
  windows first: another session may be working there.

### 7.2 B-C: longer Notitia retry on `main`

Where: `packages/core/src/spectral/utils/notitia.py`, a new branch off `main`.

- Scope **[call]**: the long budget applies to job dispatch only (`_defer_via_notitia`, immediate or delayed).
  Watchdog and park-backstop arms (`_watchdog_via_notitia`, and `_schedule_park_backstop`'s arm) keep today's
  short budget: they already retry `BACKSTOP_ARM_ATTEMPTS` times and then raise, which fails the invocation and lets
  Cloud Tasks redeliver it; multiplying that by a 10-minute inner budget would block one `execute` for about 30 min.
  Because the SDK's `RetryConfig` is per client, `notitia.py` holds two `LowLevelClient`s (dispatch, arms) instead of
  one; no SDK change.
- The dispatch client retries 429/5xx for **[call]** about 10 minutes (for example `max_attempts` around 12,
  `max_delay` 60 s), instead of today's 5 attempts in about 85 s.
- `_defer_via_notitia` also retries network errors (`httpx.TransportError`, timeouts) inside the same budget; the
  SDK does not (see the 2026-05-11 SDK spec, "out of scope"). Without a task name a retried timeout can create a
  duplicate task; for `execute` that is harmless (the job lock), which is why this is acceptable on `main` before N1.
- The budget is per invocation, not per call **[call]**: `_trigger_dependents` dispatches dependents one after
  another, so N stranded dispatches must not cost N × 10 minutes. Once one dispatch has exhausted the budget, later
  dispatches in the same process fail fast for a short cool-down (or the budget is tracked per request through a
  context variable; builder's choice). Bound: everything stays well under the 1800 s limits that apply here
  (backend Cloud Run `timeout = 1800s`; Notitia `DEFAULT_TIMEOUT_SECONDS = 1800`, the dispatch deadline of every
  `execute` and `/watchdog` relay).
- Request paths keep a short budget **[owner]**: only dispatches made inside a job invocation (the
  `/internal/jobs/{id}/execute` and `/internal/jobs/{id}/watchdog` routes, and anything they call) get the
  10-minute budget. Everything else, including API requests that dispatch a run's roots, keeps today's budget (5
  attempts, about 85 s) and fails fast, so a user sees an error instead of a hung request. The builder picks the
  mechanism (for example a context variable set by those two routes and read by `_defer_via_notitia`).
- Tests: retries on 5xx and on a transport error, gives up after the budget, logs `notitia-defer-failed` once at the
  end.

## 8. Testing (Notitia)

Jest specs next to the services (`gcp-task.scheduler.service.spec.ts` exists; add `meta.service.spec.ts`,
`schedule.helper.service.spec.ts`). Cover: rebuild on 4 and 14 and single-flight; total budget; `ALREADY_EXISTS`
after a retried create = success; name determinism and character set; idempotency key → same id; meta delivery
replayed at a different time does not fork (same names); tombstone ends the chain, including a cancel between
steps 3 and 4; cancel with and without `queue`, and with an old-form key; missed occurrences (one late fire, then on
time); cron with `tz` and RRULE with DTSTART across the 2026-10-25 Europe/Rome change; RRULE without DTSTART anchored
once; `X-Notitia-Occurrence` on relays from both schedulers; v1.3.4 meta payload without `occurrence`. SDK: pytest
for the new fields and the keyed network-error retry.

## 9. Left to the builder

- Exact keepalive values, per-attempt deadline and total budget, after checking google-gax option forwarding and the
  front end's ping policy (§6.1).
- Hash and truncation for names; readable suffix or none (§6.2).
- How `_dispatch_up_to_capacity` reports failures to the watchdog path (§7.1).
- B-C's exact `RetryConfig`, the per-invocation budget mechanism, how a dispatch knows it runs inside a job
  invocation, and whether the network-error retry lives in `notitia.py` or a small helper (§7.2).

## 10. Reminders (not in these PRs) [owner]

Raise with the owner at the end of this work, as cloud-infrastructure changes:

- `meta-jobs` queue: unlimited attempts (it only calls Notitia itself). Today a recurring chain whose meta delivery
  fails 3 times (about 35 minutes of Notitia trouble) is dead for good, and nothing notices.
- `jobs` queue: raise `max_attempts` above 3 so the 24-hour `max_retry_duration` is what binds. It is the window for
  B-A's redeliveries and release B's watchdogs.
- Notitia `min_instance_count = 1 # TODO` → 2 (incident write-up's point 2).
