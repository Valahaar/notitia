# Backend (main): retry Notitia dispatch for up to 10 minutes inside job invocations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Notitia outage of a few minutes no longer abandons a job dispatch made from inside a job invocation; API requests keep failing fast.

**Architecture:** The execute and watchdog routes set a per-request deadline (now + 600 s) in a context variable; `_defer_via_notitia` wraps the unchanged SDK call (which already does its own 5-attempt round) in an outer loop that retries retryable failures with backoff until that deadline. Outside a job invocation, or once the deadline has passed, a dispatch gets one ordinary round, as today.

**Tech Stack:** Python 3.12, FastAPI, structlog, Notitia Python SDK 1.2.0 (`LowLevelClient`, `NotitiaError`), pytest-asyncio, uv.

**Spec:** `/home/nick/principled/.orchard-worktrees/session-batched-evals/notitia/docs/superpowers/specs/2026-11-16-cloud-tasks-reliability-and-recurring-design.md` §4.1 (C) and §7.2.

## Global Constraints

- New branch `fix/notitia-dispatch-retry` off `origin/main`, in a git worktree of this workspace's clone: `git -C /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend worktree add -b fix/notitia-dispatch-retry /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-notitia-retry origin/main`, then `uv sync` there. The clone itself stays on `feat/session-batched-evals`.
- Budget: 600 s from the start of the job invocation; backoff between rounds `min(60, 2 ** round)` seconds with ±50% jitter.
- Retryable: `NotitiaError` with `status is None` (network error, timeout) or `status == 429` or `status >= 500`. Anything else is raised at once.
- Only `_defer_via_notitia` gets the outer loop. `_watchdog_via_notitia` (and every arm built on it) is unchanged.
- No SDK change, no Notitia change, no change to the runner (`packages/jobs`).
- Run only the affected tests per task; the backend + core test packages once at the end.
- PR through the `release-flow:create-pr` skill.

## Review Focus

- `_trigger_dependents` dispatching several dependents while Notitia is down: the request spends at most about 600 s in total, not 600 s per dependent (Task 1 test `later dispatches get one round once the deadline passed`).
- A 400/422 from Notitia (bad request): raised at once, no retry loop (Task 1 test `does not retry a client error`).
- A dispatch from an API request (no budget set): exactly one SDK round, as today (Task 1 test `outside a job invocation there is one round`).
- A delayed dispatch (`delay_seconds > 0`) retried late: the `OneTimeSchedule` time is recomputed per round so the task is not scheduled in the past by the retry delay (Task 1 test `recomputes the delayed run time each round`).
- Two concurrent requests in one process: each has its own deadline (Task 1 test `budgets are per request`).

---

### Task 1: Per-invocation dispatch budget in `notitia.py`

**Files:**
- Modify: `packages/core/src/spectral/utils/notitia.py`
- Create: `packages/core/tests/utils/test_notitia_dispatch_retry.py`
- Modify: `.knowledge/architecture/jobs/job-system.md` (the paragraph on deferral through Notitia: the budget and where it applies)

**Interfaces:**
- Produces:
  - `JOB_INVOCATION_DISPATCH_BUDGET_SECONDS = 600`
  - `@contextmanager def job_invocation_dispatch_budget(seconds: float = JOB_INVOCATION_DISPATCH_BUDGET_SECONDS) -> Iterator[None]` — sets a `ContextVar[float | None]` (`_dispatch_deadline`, a `time.monotonic()` value) for the block and resets it with the token afterwards.
  - `_defer_via_notitia(job_id, delay_seconds=0)` keeps its signature. Loop: build the request (recomputing `run_at` for delayed dispatches), call `_client.send_schedule_request`; on a retryable `NotitiaError`, if a deadline is set and `monotonic() + next_delay < deadline`, log `notitia-defer-retrying` (`job_id`, `round`, `status`, `delay_seconds`) at warning, sleep, and go again; otherwise log `notitia-defer-failed` once (as today, with `rounds`) and raise.
- Consumes: `notitia.NotitiaError` (`.status: int | None`).

- [ ] **Step 1: Write the failing tests** (patch `notitia._client` with an `AsyncMock`, patch `asyncio.sleep` and `time.monotonic` in the module to a fake clock that advances on sleep):
  - `test_outside_a_job_invocation_there_is_one_round`: `send_schedule_request` raises `NotitiaError(status=504)` → raised; called once; no sleep.
  - `test_retries_until_success_inside_a_job_invocation`: raises 504 twice, then returns `"j"`; inside `job_invocation_dispatch_budget()` → no error; called 3 times.
  - `test_retries_network_errors`: raises `NotitiaError(status=None)` once, then succeeds → called twice.
  - `test_does_not_retry_a_client_error`: `NotitiaError(status=422)` → raised after one call even inside the budget.
  - `test_gives_up_at_the_deadline`: always 503, budget 600 → raised; total fake sleep ≤ 600; `notitia-defer-failed` logged once (use `structlog.testing.capture_logs`).
  - `test_later_dispatches_get_one_round_once_the_deadline_passed`: first dispatch exhausts the budget; a second dispatch in the same block → one call, raised, no sleep.
  - `test_recomputes_the_delayed_run_time_each_round`: `delay_seconds=30`, one 503 then success, fake clock and `datetime.now` advanced by the sleep → the second request's `schedule.time` is later than the first by the slept time.
  - `test_budgets_are_per_request`: two tasks under `asyncio.gather`, each entering its own `job_invocation_dispatch_budget(seconds=…)` with different values → each sees its own deadline (assert via the number of rounds each made).

- [ ] **Step 2: Run to verify they fail**

Run: `cd /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-notitia-retry && uv run pytest packages/core/tests/utils/test_notitia_dispatch_retry.py -q`
Expected: FAIL (`job_invocation_dispatch_budget` not defined).

- [ ] **Step 3: Implement** the Interfaces block. Use `time.monotonic` for the deadline (not wall clock); `random.uniform(0.5, 1.5)` for jitter.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest packages/core/tests/utils/test_notitia_dispatch_retry.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/spectral/utils/notitia.py packages/core/tests/utils/test_notitia_dispatch_retry.py .knowledge/architecture/jobs/job-system.md
git commit -m "fix(jobs): retry a Notitia dispatch for up to 10 minutes inside a job invocation"
```

### Task 2: The execute and watchdog routes open the budget

**Files:**
- Modify: `packages/backend/src/spectral/backend/routers/jobs.py` — `execute_job` (~line 65) and `watchdog_job` (~line 131): run the runner call inside `with job_invocation_dispatch_budget():`; one sentence in each docstring.
- Test: `packages/backend/tests/test_jobs_execute_endpoint.py`, `packages/backend/tests/test_jobs_watchdog_endpoint.py`

**Interfaces:**
- Consumes: `job_invocation_dispatch_budget` and the `_dispatch_deadline` context variable from `spectral.utils.notitia` (Task 1).

- [ ] **Step 1: Write the failing tests**: in each endpoint test file, `test_runs_the_runner_inside_the_dispatch_budget` — replace the runner dependency with a fake whose `execute`/`watchdog` records `notitia._dispatch_deadline.get()`; call the endpoint; assert the recorded value is not None; assert `notitia._dispatch_deadline.get()` is None after the request.
- [ ] **Step 2: Run to verify they fail**: `uv run pytest packages/backend/tests/test_jobs_execute_endpoint.py packages/backend/tests/test_jobs_watchdog_endpoint.py -q` → FAIL.
- [ ] **Step 3: Implement** (two `with` blocks; nothing else in the routes changes).
- [ ] **Step 4: Run the affected tests** (same command) → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/spectral/backend/routers/jobs.py packages/backend/tests/test_jobs_execute_endpoint.py packages/backend/tests/test_jobs_watchdog_endpoint.py
git commit -m "fix(jobs): job invocations get the long Notitia dispatch budget; API requests keep the short one"
```

### Finish

- [ ] Run: `uv run pytest packages/core packages/backend -q` → all pass.
- [ ] Open the PR with the `release-flow:create-pr` skill (it picks the target branch and template). Body: the 2026-11-10 incident in two sentences; the budget and where it applies; that it is the stopgap until #530 (watchdog re-triggers dependents) is deployed; link to the spec.
- [ ] After the PR is open, remove the worktree only when the user says the branch is done: `git -C /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend worktree remove /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-notitia-retry`.
