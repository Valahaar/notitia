# Backend (#530): the watchdog re-triggers undispatched dependents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a job's watchdog fires on a terminal job, dispatch that job's dependents whose dispatch never happened (the 2026-11-10 `finalize_attack` case), failing the watchdog so Cloud Tasks redelivers it when a dispatch fails.

**Architecture:** Reuse `_trigger_dependents` with an `only_undispatched` filter (`dispatched_at: null`), so the normal case costs one Mongo query and no Notitia call; make the dispatch helpers report failures up to it; the watchdog raises on any failure. Committed inside draft PR #530, then the two unpushed branches stacked on it are rebased.

**Tech Stack:** Python 3.12, Beanie 2 / PyMongo async, FastAPI, pytest (+ mongomock-motor; real Mongo via `REAL_MONGO_URI`), uv.

**Spec:** `/home/nick/principled/.orchard-worktrees/session-batched-evals/notitia/docs/superpowers/specs/2026-11-16-cloud-tasks-reliability-and-recurring-design.md` §4.1 and §7.1. Background: the durable-execution campaign spec `.superpowers/campaigns/2026-11-11-durable-execution/specs/2026-11-11-durable-execution-design.md` §5.2 and §5.4 (on the branch).

## Global Constraints

- Branch `feat/jobkit-lock-watchdogs` (draft #530), new commits on top; no new PR, no stacking.
- The clone at `/home/nick/principled/.orchard-worktrees/job-workflows-system/spectral-backend` has `feat/jobkit-durable-hardening` checked out and a live session (tmux window `p2b-hardening`). Do not switch its branch. Work in a git worktree of that clone at `/home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-530` (`git -C <clone> worktree add <path> feat/jobkit-lock-watchdogs`; `uv sync` there).
- Behaviour outside the watchdog's terminal branch is unchanged: `_trigger_dependents` without the new flag behaves exactly as today.
- Every rescue is per job; no sweep, cron or poller (owner ruling 2026-11-11).
- Run only the affected test files per task; the full suite once at the end: core/backend/cli/jobs with `REAL_MONGO_URI=mongodb://localhost:27017`, as the campaign's reviews did.
- Knowledge and campaign docs change in the same commit as the code.

## Review Focus

- A terminal job whose dependent was already dispatched (the normal case): the watchdog makes no transport call at all (Task 1 test `no call when the dependent was dispatched`).
- A dependent still waiting on a second, unfinished dependency: left alone, no call, watchdog ends (Task 1 test `leaves a dependent with an unfinished sibling dependency`).
- Notitia still down when the watchdog fires: the watchdog raises (500) and the dependent stays `dispatched_at: null` for the redelivery (Task 1 test `raises when a dispatch fails`).
- A failed (not completed) terminal job: its dependent is deferred to run `on_dependency_failed`, like the normal path (Task 1 test `defers a dependent of a failed job`).
- A watchdog fired for a terminal job that has no dependents: one query, `"ended"`, unchanged outcome (existing test `test_watchdog_on_a_terminal_job_ends` keeps passing).

---

### Task 1: Report dispatch failures and re-trigger dependents from the watchdog

**Files:**
- Modify: `packages/jobs/src/jobkit/runner.py` — `_dispatch_unparked` (~1437), `_dispatch_up_to_capacity` (~1515), `_admit_candidate` (~1578), `_trigger_dependents` (~2276), `watchdog` (~2520) and its docstring; `WatchdogOutcome` unchanged.
- Modify: `packages/backend/src/spectral/backend/routers/jobs.py` — `watchdog_job` docstring (a dependent dispatch failure also answers 500).
- Test: `packages/core/tests/jobs/test_runner_watchdog.py` (new tests next to `test_watchdog_on_a_terminal_job_ends`)
- Modify docs (same commit): `.superpowers/campaigns/2026-11-11-durable-execution/specs/2026-11-11-durable-execution-design.md` §5.2 (terminal job: re-trigger undispatched dependents) and §5.4 (the "known residual gap" paragraph: closed for any job with a watchdog; still open for jobs that never had one, e.g. blocking jobs); `.knowledge/architecture/jobs/job-system-parking.md` (the recovery gap) and `.knowledge/architecture/jobs/job-runner-lifecycle.md` (watchdog outcomes).

**Interfaces:**
- Produces:
  - `class DependentDispatchFailed(RuntimeError)` in `jobkit/runner.py`, message `"<n> dependent dispatch(es) of job <id> failed"`, attributes `job_id: str`, `failed: int`.
  - `_dispatch_unparked(self, job) -> bool` (what `_safe_dispatch` returned).
  - `_admit_candidate(...) -> str` gains outcome `"dispatch_failed"` (FULLY_RESERVED but `_safe_dispatch` returned False; it still releases the entries as today).
  - `_dispatch_up_to_capacity(self, candidates) -> int` — number of candidates that failed: `_dispatch_unparked` False, `"dispatch_failed"`, or the per-candidate `except Exception`.
  - `_trigger_dependents(self, completed_job_id: str, workflow_id: str, *, only_undispatched: bool = False) -> int` — failed count (failed-dependency `_safe_dispatch` False counts too). With `only_undispatched=True` the find filter adds `"dispatched_at": None` (matches missing too).
- In `watchdog`, the terminal branch becomes: `failed = await self._trigger_dependents(job_id, job.workflow_id, only_undispatched=True)`; if `failed`: log `watchdog-dependent-dispatch-failed` (`job_id`, `failed`) at error and `raise DependentDispatchFailed(...)`; else `return "ended"`.

- [ ] **Step 1: Write the failing tests** in `test_runner_watchdog.py`. Build a two-node graph as `test_runner_cancel_requested.py` does (`JobGraph.of(A, blocking=False).then(JobGraph.of(B, blocking=False))`, run through a seeder runner without a watchdog transport), complete the parent (`await stored.complete()`), set the dependent's `dispatched_at` per test, and reset `runner._defer_fn`:
  - `test_watchdog_on_a_terminal_job_dispatches_an_undispatched_dependent`: dependent `dispatched_at=None` → outcome `"ended"`; `runner._defer_fn.assert_awaited_once_with(str(dependent.id))`; dependent's raw `dispatched_at` is now set.
  - `test_no_call_when_the_dependent_was_dispatched`: dependent `dispatched_at=now` → `"ended"`; `_defer_fn` not awaited.
  - `test_leaves_a_dependent_with_an_unfinished_sibling_dependency`: a diamond (two parents → one dependent), only one parent completed → `"ended"`; `_defer_fn` not awaited.
  - `test_defers_a_dependent_of_a_failed_job`: parent failed instead of completed → `_defer_fn` awaited once with the dependent's id.
  - `test_raises_when_a_dispatch_fails`: `runner._defer_fn.side_effect = RuntimeError("notitia down")` → `pytest.raises(DependentDispatchFailed)`; dependent's raw `dispatched_at` still None; a second call after clearing the side effect returns `"ended"` and dispatches.
  - `test_a_second_firing_does_not_dispatch_twice`: after a successful re-trigger, firing again → `_defer_fn` awaited once in total.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-530 && uv run pytest packages/core/tests/jobs/test_runner_watchdog.py -q`
Expected: the new tests FAIL (no dispatch / no `DependentDispatchFailed`), existing ones PASS.

- [ ] **Step 3: Implement** the Interfaces block. Keep every existing caller's behaviour: callers that ignore the new return values stay as they are; `_trigger_dependents`' docstring gains one paragraph on `only_undispatched`; `watchdog`'s docstring replaces "a terminal job: `ended`" with the re-trigger and the raise. If the dependents query needs an index, it does not: `depends_on` is already queried this way on every completion.

- [ ] **Step 4: Run the affected tests**

Run: `uv run pytest packages/core/tests/jobs/test_runner_watchdog.py packages/core/tests/jobs/test_runner_watchdog_arming.py packages/core/tests/jobs/test_runner_dispatch.py packages/core/tests/jobs/test_runner_cancel_requested.py packages/core/tests/jobs/test_runner_canceled_state.py packages/jobs/tests -q`
Expected: PASS.

- [ ] **Step 5: Update the docs** listed under Files (spec §5.2/§5.4, the two knowledge pages, the route docstring).

- [ ] **Step 6: Commit**

```bash
git add packages/jobs/src/jobkit/runner.py packages/backend/src/spectral/backend/routers/jobs.py packages/core/tests/jobs/test_runner_watchdog.py .superpowers/campaigns/2026-11-11-durable-execution/specs .knowledge/architecture/jobs
git commit -m "feat(jobs): a terminal job's watchdog dispatches dependents whose dispatch was abandoned"
```

### Task 2: Tracker, full suite, push to #530

**Files:**
- Modify: `.superpowers/campaigns/2026-11-11-durable-execution/tracker.md` — "Last updated" line; Plan graph row 1 status mentions the addition; "Release B pre-deploy gate" item 2 adds that dependent rescues also ride the jobs queue's redelivery budget (3 attempts, about 35 minutes today); "Release gates and follow-ups" notes that #530 now covers the 2026-11-10 incident's abandoned dispatch.

- [ ] **Step 1: Edit the tracker** as listed.
- [ ] **Step 2: Run the full suite**

Run: `REAL_MONGO_URI=mongodb://localhost:27017 uv run pytest packages/core packages/backend packages/cli packages/jobs -q` (start a local Mongo first if none listens on 27017), then `uv run pytest packages/gateway -q` and `uv run pytest packages/mcp -q`
Expected: all pass (counts close to the tracker's last run: about 8.4k core/backend/cli/jobs).

- [ ] **Step 3: Commit and push**

```bash
git add .superpowers/campaigns/2026-11-11-durable-execution/tracker.md
git commit -m "docs(jobs): tracker — #530 also re-triggers abandoned dependent dispatches"
git push origin feat/jobkit-lock-watchdogs
```

- [ ] **Step 4: Update #530's description** with `gh pr edit 530 --body-file <file>`: read the current body first (`gh pr view 530 --json body`), add a section "Abandoned dependent dispatch (2026-11-10 incident)" with two sentences on what the watchdog now does and the new 500 case. Keep the PR a draft.

### Task 3: Rebase the local branches stacked on #530

**Files:** none new; conflict resolution in `packages/jobs/src/jobkit/runner.py` (`watchdog` terminal branch and docstring).

- [ ] **Step 1: Rebase `feat/jobkit-durable-core`** in the worktree (it is not checked out anywhere). First record its current head: `OLD_CORE=$(git rev-parse feat/jobkit-durable-core)` (write it down; Step 3 needs it). Then `git switch feat/jobkit-durable-core && git rebase feat/jobkit-lock-watchdogs`. Expected conflict in `watchdog`: durable-core calls `await self._on_terminal(job)` there and says "dependents are not re-triggered here". Resolve to: `_on_terminal(job)` first, then the re-trigger and raise from Task 1; docstring says both.
- [ ] **Step 2: Run the affected tests on durable-core**: `uv run pytest packages/core/tests/jobs/test_runner_watchdog.py packages/core/tests/jobs -k "watchdog or durable or terminal" -q` → PASS.
- [ ] **Step 3: `feat/jobkit-durable-hardening`** is checked out in the job-workflows-system clone by the `p2b-hardening` session. Stop and ask the user before touching it. Once they confirm that session is idle: in that clone, `git rebase --onto feat/jobkit-durable-core $OLD_CORE feat/jobkit-durable-hardening` (replays only hardening's own commits onto the rebased durable-core), resolve any conflict the same way, run the same tests. Neither branch is pushed (tracker: "local, not pushed"); do not push them.
- [ ] **Step 4: Remove the worktree** after the user has approved the result: `git -C /home/nick/principled/.orchard-worktrees/job-workflows-system/spectral-backend worktree remove /home/nick/principled/.orchard-worktrees/session-batched-evals/spectral-backend-530`.
