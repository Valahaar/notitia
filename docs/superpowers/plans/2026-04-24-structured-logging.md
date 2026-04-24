# Structured Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace NestJS's default text logger in `packages/service` with GCP-native structured JSON logging via `nestjs-pino`, correlated by `X-Request-ID` and `X-Cloud-Trace-Context`, with env-driven level / format / sampling / redaction control and Error Reporting + audit-event routing.

**Architecture:** `nestjs-pino` replaces the default `LoggerService` at bootstrap. A `LoggerModule.forRootAsync` reads env vars, builds pino config (severity mapping, sampling hook, redact paths, optional pretty-print), and validates inputs at startup. A new `TraceContextMiddleware` parses `X-Cloud-Trace-Context` after `RequestIdMiddleware`; `nestjs-pino`'s `customProps` copies both onto every log record inside the request scope. Thin helpers `logAudit` / `logError` encode the two special emissions (audit label + Error Reporting `@type`). Most existing `this.logger.log(...)` call sites keep working unchanged; only four sites are forced migrations.

**Tech Stack:** NestJS 11 (existing), pino 9, nestjs-pino 4, pino-pretty 11 (dev dep), jest 29 (existing, currently zero tests).

**Reference spec:** `docs/superpowers/specs/2026-04-24-structured-logging-design.md`.

---

## File Map

**New files under `packages/service/src/common/logger/`:**
- `trace.ts` — `parseCloudTrace(header, projectId)` pure function.
- `trace.spec.ts` — unit tests for `parseCloudTrace`.
- `redact.ts` — `buildRedactPaths(userList)` pure function.
- `redact.spec.ts` — unit tests for `buildRedactPaths`.
- `sampler.ts` — pino `logMethod` hook for sampling.
- `sampler.spec.ts` — unit tests for sampler behavior.
- `severity.ts` — `levelToSeverity(label)` pure function (pino label → GCP severity).
- `severity.spec.ts` — unit tests for level mapping.
- `helpers.ts` — `logAudit(logger, event, fields)` and `logError(logger, err, fields)`.
- `helpers.spec.ts` — unit tests for the two helpers.
- `config.ts` — `readLoggerEnv(env)` reads + validates `LOG_*` env vars, returns typed config.
- `config.spec.ts` — unit tests for env validation.
- `logger.module.ts` — NestJS module wiring pino config via `LoggerModule.forRootAsync`.

**New middleware:**
- `packages/service/src/common/middleware/trace-context.middleware.ts`
- `packages/service/src/common/middleware/trace-context.middleware.spec.ts`

**Integration test:**
- `packages/service/src/common/logger/logger.integration.spec.ts` — boots AppModule with a captured stdout stream, asserts JSON shape.

**Modified files:**
- `packages/service/package.json` — add `pino`, `nestjs-pino`, `pino-http` deps; add `pino-pretty` dev dep.
- `packages/service/src/app.module.ts` — import `LoggerModule`, register `TraceContextMiddleware` after `RequestIdMiddleware`.
- `packages/service/src/main.ts` — swap in pino logger via `app.useLogger(app.get(Logger))`, call `app.flushLogs()` after bootstrap.
- `packages/service/src/common/filters/all-exceptions.filter.ts` — use `logError`.
- `packages/service/src/common/filters/http-exception.filter.ts` — use `logError`.
- `packages/service/src/modules/job-scheduling/job-scheduling.controller.ts` (lines 58, 72) — use `logAudit`.
- `packages/service/src/modules/job-scheduling/job-scheduling.service.ts` (line 16) — fix broken 2-arg `log` call.
- `packages/service/src/common/services/http-executor.service.ts` — tag success pair `sampleable: true`, use structured fields.
- `packages/service/README.md` — document new env vars.
- `docker-compose.yml` — commented-out examples for new env vars.

**New docs:**
- `packages/python-sdk/docs/logging.md` — GCP-compatible stdlib `logging.Formatter` snippet for SDK consumers.

---

## Task 1: Install dependencies

**Files:**
- Modify: `packages/service/package.json`

- [ ] **Step 1: Install runtime deps**

Run from repo root:

```bash
cd packages/service && yarn add pino@^9 nestjs-pino@^4 pino-http@^10
```

Expected: `package.json` gains three entries under `dependencies`; `yarn.lock` updates.

- [ ] **Step 2: Install dev dep**

```bash
cd packages/service && yarn add --dev pino-pretty@^11
```

Expected: `package.json` gains `pino-pretty` under `devDependencies`.

- [ ] **Step 3: Verify the build still compiles**

```bash
cd packages/service && yarn build
```

Expected: clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/service/package.json packages/service/yarn.lock
git commit -m "chore(deps): Add pino + nestjs-pino for structured logging"
```

---

## Task 2: `parseCloudTrace` helper

**Files:**
- Create: `packages/service/src/common/logger/trace.ts`
- Create: `packages/service/src/common/logger/trace.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/service/src/common/logger/trace.spec.ts`:

```ts
import { parseCloudTrace } from './trace';

describe('parseCloudTrace', () => {
    it('returns empty object when header is missing', () => {
        expect(parseCloudTrace(undefined, 'my-proj')).toEqual({});
        expect(parseCloudTrace('', 'my-proj')).toEqual({});
    });

    it('parses trace/span/sampled with ;o=1', () => {
        const result = parseCloudTrace('abc123/456;o=1', 'my-proj');
        expect(result).toEqual({
            'logging.googleapis.com/trace': 'projects/my-proj/traces/abc123',
            'logging.googleapis.com/spanId': '456',
            'logging.googleapis.com/trace_sampled': true,
        });
    });

    it('parses ;o=0 as not sampled', () => {
        const result = parseCloudTrace('abc123/456;o=0', 'my-proj');
        expect(result['logging.googleapis.com/trace_sampled']).toBe(false);
    });

    it('omits spanId when span segment is absent', () => {
        const result = parseCloudTrace('abc123', 'my-proj');
        expect(result['logging.googleapis.com/trace']).toBe('projects/my-proj/traces/abc123');
        expect(result['logging.googleapis.com/spanId']).toBeUndefined();
    });

    it('emits bare trace (no project qualifier) when projectId absent', () => {
        const result = parseCloudTrace('abc123/456;o=1', undefined);
        expect(result['logging.googleapis.com/trace']).toBe('abc123');
    });

    it('returns empty object on malformed header', () => {
        expect(parseCloudTrace('///;;;', 'my-proj')).toEqual({});
    });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
cd packages/service && yarn jest src/common/logger/trace.spec.ts
```

Expected: FAIL — `Cannot find module './trace'`.

- [ ] **Step 3: Implement `parseCloudTrace`**

Create `packages/service/src/common/logger/trace.ts`:

```ts
export type CloudTraceFields = Partial<{
    'logging.googleapis.com/trace': string;
    'logging.googleapis.com/spanId': string;
    'logging.googleapis.com/trace_sampled': boolean;
}>;

const HEADER_RE = /^([a-f0-9]+)(?:\/(\d+))?(?:;o=([01]))?$/i;

export function parseCloudTrace(header: string | undefined, projectId: string | undefined): CloudTraceFields {
    if (!header) return {};
    const match = HEADER_RE.exec(header);
    if (!match) return {};

    const [, traceId, spanId, sampled] = match;
    const trace = projectId ? `projects/${projectId}/traces/${traceId}` : traceId;

    const out: CloudTraceFields = { 'logging.googleapis.com/trace': trace };
    if (spanId) out['logging.googleapis.com/spanId'] = spanId;
    if (sampled !== undefined) out['logging.googleapis.com/trace_sampled'] = sampled === '1';
    return out;
}
```

- [ ] **Step 4: Run the tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/trace.spec.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/trace.ts packages/service/src/common/logger/trace.spec.ts
git commit -m "feat(logger): Add parseCloudTrace helper for X-Cloud-Trace-Context"
```

---

## Task 3: `levelToSeverity` helper

**Files:**
- Create: `packages/service/src/common/logger/severity.ts`
- Create: `packages/service/src/common/logger/severity.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/logger/severity.spec.ts`:

```ts
import { levelToSeverity } from './severity';

describe('levelToSeverity', () => {
    it.each([
        ['trace', 'DEBUG'],
        ['debug', 'DEBUG'],
        ['info', 'INFO'],
        ['warn', 'WARNING'],
        ['error', 'ERROR'],
        ['fatal', 'CRITICAL'],
    ])('maps pino %s to GCP %s', (label, expected) => {
        expect(levelToSeverity(label)).toBe(expected);
    });

    it('falls back to DEFAULT for unknown levels', () => {
        expect(levelToSeverity('unknown')).toBe('DEFAULT');
    });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd packages/service && yarn jest src/common/logger/severity.spec.ts
```

Expected: FAIL — `Cannot find module './severity'`.

- [ ] **Step 3: Implement `levelToSeverity`**

Create `packages/service/src/common/logger/severity.ts`:

```ts
const MAP: Record<string, string> = {
    trace: 'DEBUG',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARNING',
    error: 'ERROR',
    fatal: 'CRITICAL',
};

export function levelToSeverity(label: string): string {
    return MAP[label] ?? 'DEFAULT';
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/severity.spec.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/severity.ts packages/service/src/common/logger/severity.spec.ts
git commit -m "feat(logger): Map pino levels to GCP severity labels"
```

---

## Task 4: `buildRedactPaths` helper

**Files:**
- Create: `packages/service/src/common/logger/redact.ts`
- Create: `packages/service/src/common/logger/redact.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/logger/redact.spec.ts`:

```ts
import { buildRedactPaths, DEFAULT_REDACT_PATHS } from './redact';

describe('buildRedactPaths', () => {
    it('returns the default paths when no user list provided', () => {
        expect(buildRedactPaths('')).toEqual(DEFAULT_REDACT_PATHS);
        expect(buildRedactPaths(undefined)).toEqual(DEFAULT_REDACT_PATHS);
    });

    it('appends comma-separated user paths after defaults', () => {
        const result = buildRedactPaths('foo.bar, baz.qux');
        expect(result).toEqual([...DEFAULT_REDACT_PATHS, 'foo.bar', 'baz.qux']);
    });

    it('ignores empty entries from trailing/duplicate commas', () => {
        const result = buildRedactPaths('foo.bar,,,baz.qux,');
        expect(result).toEqual([...DEFAULT_REDACT_PATHS, 'foo.bar', 'baz.qux']);
    });

    it('defaults cover authorization, cookie, password, token, secret', () => {
        expect(DEFAULT_REDACT_PATHS).toEqual(
            expect.arrayContaining([
                'req.headers.authorization',
                'req.headers.cookie',
                '*.password',
                '*.token',
                '*.secret',
            ]),
        );
    });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
cd packages/service && yarn jest src/common/logger/redact.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildRedactPaths`**

Create `packages/service/src/common/logger/redact.ts`:

```ts
export const DEFAULT_REDACT_PATHS: string[] = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-goog-*"]',
    '*.password',
    '*.token',
    '*.secret',
    '*.apiKey',
    '*.api_key',
];

export function buildRedactPaths(userList: string | undefined): string[] {
    const extras = (userList ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return [...DEFAULT_REDACT_PATHS, ...extras];
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/redact.spec.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/redact.ts packages/service/src/common/logger/redact.spec.ts
git commit -m "feat(logger): Build pino redact paths with defaults + LOG_REDACT"
```

---

## Task 5: Sampler hook

**Files:**
- Create: `packages/service/src/common/logger/sampler.ts`
- Create: `packages/service/src/common/logger/sampler.spec.ts`

**Background:** pino's `hooks.logMethod` runs before each log call. Its signature is `function (this, args, method, level): void`. `args` is the argument array the caller passed; `level` is the numeric level (`info=30`, `warn=40`, `error=50`, `fatal=60`). If we call `method.apply(this, args)`, the log emits; if we return without calling `method`, the log is dropped.

The first element of `args` can be either a message string (no bindings) or an object followed by a message string. We inspect the object for our two flags: `audit: true` (never sample) and `sampleable: true` (eligible). For numeric levels ≥40 (warn+), pass unconditionally.

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/logger/sampler.spec.ts`:

```ts
import { makeSampler } from './sampler';

describe('makeSampler', () => {
    // pino-equivalent numeric levels
    const INFO = 30;
    const WARN = 40;
    const ERROR = 50;

    function simulate(sampler: ReturnType<typeof makeSampler>, args: unknown[], level: number) {
        let emitted = false;
        const method = function () { emitted = true; };
        sampler.call({}, args as any, method as any, level);
        return emitted;
    }

    it('passes warn unconditionally regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], WARN)).toBe(true);
    });

    it('passes error unconditionally regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], ERROR)).toBe(true);
    });

    it('passes audit: true at info even with rate=0', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{ audit: true }, 'msg'], INFO)).toBe(true);
    });

    it('passes info without sampleable flag regardless of rate', () => {
        const sampler = makeSampler(0, () => 0.99);
        expect(simulate(sampler, [{}, 'msg'], INFO)).toBe(true);
        expect(simulate(sampler, ['just a string'], INFO)).toBe(true);
    });

    it('drops sampleable info when random >= rate', () => {
        const sampler = makeSampler(0.1, () => 0.5); // 0.5 >= 0.1
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], INFO)).toBe(false);
    });

    it('keeps sampleable info when random < rate', () => {
        const sampler = makeSampler(0.5, () => 0.1); // 0.1 < 0.5
        expect(simulate(sampler, [{ sampleable: true }, 'msg'], INFO)).toBe(true);
    });

    it('Monte Carlo: ~50% retention over many draws at rate 0.5', () => {
        let rngCount = 0;
        // deterministic sequence interleaving below/above 0.5
        const rng = () => ((rngCount++ % 10) * 0.1);
        const sampler = makeSampler(0.5, rng);
        let kept = 0;
        for (let i = 0; i < 10_000; i++) {
            if (simulate(sampler, [{ sampleable: true }, 'msg'], INFO)) kept++;
        }
        expect(kept).toBeGreaterThan(4_800);
        expect(kept).toBeLessThan(5_200);
    });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd packages/service && yarn jest src/common/logger/sampler.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sampler factory**

Create `packages/service/src/common/logger/sampler.ts`:

```ts
type LogArgs = unknown[];
type LogMethod = (this: unknown, ...args: LogArgs) => void;

// numeric level thresholds (pino defaults): warn=40, so anything < 40 is info/debug/trace
const WARN_LEVEL = 40;

export function makeSampler(sampleRate: number, rng: () => number = Math.random) {
    return function logMethod(this: unknown, args: LogArgs, method: LogMethod, level: number) {
        if (level >= WARN_LEVEL) {
            method.apply(this, args);
            return;
        }
        const first = args[0];
        if (first && typeof first === 'object') {
            const bindings = first as Record<string, unknown>;
            if (bindings.audit === true) {
                method.apply(this, args);
                return;
            }
            if (bindings.sampleable === true && rng() >= sampleRate) {
                return; // drop
            }
        }
        method.apply(this, args);
    };
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/sampler.spec.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/sampler.ts packages/service/src/common/logger/sampler.spec.ts
git commit -m "feat(logger): Add level-aware sampling hook"
```

---

## Task 6: Logger env validation + config builder

**Files:**
- Create: `packages/service/src/common/logger/config.ts`
- Create: `packages/service/src/common/logger/config.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/logger/config.spec.ts`:

```ts
import { readLoggerEnv } from './config';

describe('readLoggerEnv', () => {
    it('applies dev defaults when NODE_ENV is not production', () => {
        const cfg = readLoggerEnv({ NODE_ENV: 'development' });
        expect(cfg.level).toBe('debug');
        expect(cfg.format).toBe('pretty');
        expect(cfg.sampleRate).toBe(1.0);
        expect(cfg.includeSource).toBe(true); // debug implies source on
    });

    it('applies prod defaults when NODE_ENV=production', () => {
        const cfg = readLoggerEnv({ NODE_ENV: 'production' });
        expect(cfg.level).toBe('info');
        expect(cfg.format).toBe('json');
        expect(cfg.sampleRate).toBe(1.0);
        expect(cfg.includeSource).toBe(false);
    });

    it('honors explicit env overrides', () => {
        const cfg = readLoggerEnv({
            NODE_ENV: 'production',
            LOG_LEVEL: 'warn',
            LOG_FORMAT: 'pretty',
            LOG_SAMPLE_RATE: '0.25',
            LOG_INCLUDE_SOURCE: 'true',
            LOG_REDACT: 'foo.bar',
        });
        expect(cfg.level).toBe('warn');
        expect(cfg.format).toBe('pretty');
        expect(cfg.sampleRate).toBe(0.25);
        expect(cfg.includeSource).toBe(true);
        expect(cfg.redactEnv).toBe('foo.bar');
    });

    it('throws on invalid LOG_LEVEL', () => {
        expect(() => readLoggerEnv({ LOG_LEVEL: 'verbose' }))
            .toThrow(/LOG_LEVEL/);
    });

    it('throws on invalid LOG_FORMAT', () => {
        expect(() => readLoggerEnv({ LOG_FORMAT: 'xml' }))
            .toThrow(/LOG_FORMAT/);
    });

    it('throws on LOG_SAMPLE_RATE out of range', () => {
        expect(() => readLoggerEnv({ LOG_SAMPLE_RATE: '-0.1' })).toThrow(/LOG_SAMPLE_RATE/);
        expect(() => readLoggerEnv({ LOG_SAMPLE_RATE: '1.5' })).toThrow(/LOG_SAMPLE_RATE/);
        expect(() => readLoggerEnv({ LOG_SAMPLE_RATE: 'abc' })).toThrow(/LOG_SAMPLE_RATE/);
    });

    it('throws on invalid LOG_INCLUDE_SOURCE', () => {
        expect(() => readLoggerEnv({ LOG_INCLUDE_SOURCE: 'yes' })).toThrow(/LOG_INCLUDE_SOURCE/);
    });

    it('auto-enables includeSource when level=debug even if env unset', () => {
        const cfg = readLoggerEnv({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
        expect(cfg.includeSource).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd packages/service && yarn jest src/common/logger/config.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readLoggerEnv`**

Create `packages/service/src/common/logger/config.ts`:

```ts
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';

export interface LoggerConfig {
    level: LogLevel;
    format: LogFormat;
    sampleRate: number;
    includeSource: boolean;
    redactEnv: string;
    projectId: string | undefined;
}

const VALID_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const VALID_FORMATS: readonly LogFormat[] = ['json', 'pretty'];

export function readLoggerEnv(env: Record<string, string | undefined>): LoggerConfig {
    const isProd = env.NODE_ENV === 'production';

    const level = (env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')) as LogLevel;
    if (!VALID_LEVELS.includes(level)) {
        throw new Error(`LOG_LEVEL must be one of ${VALID_LEVELS.join('|')} (got "${env.LOG_LEVEL}")`);
    }

    const format = (env.LOG_FORMAT ?? (isProd ? 'json' : 'pretty')) as LogFormat;
    if (!VALID_FORMATS.includes(format)) {
        throw new Error(`LOG_FORMAT must be "json" or "pretty" (got "${env.LOG_FORMAT}")`);
    }

    const rateRaw = env.LOG_SAMPLE_RATE;
    const sampleRate = rateRaw === undefined ? 1.0 : Number(rateRaw);
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        throw new Error(`LOG_SAMPLE_RATE must be a number in [0, 1] (got "${rateRaw}")`);
    }

    const includeSourceRaw = env.LOG_INCLUDE_SOURCE;
    let includeSource: boolean;
    if (includeSourceRaw === undefined) {
        includeSource = level === 'debug' || level === 'trace';
    } else if (includeSourceRaw === 'true') {
        includeSource = true;
    } else if (includeSourceRaw === 'false') {
        includeSource = false;
    } else {
        throw new Error(`LOG_INCLUDE_SOURCE must be "true" or "false" (got "${includeSourceRaw}")`);
    }

    return {
        level,
        format,
        sampleRate,
        includeSource,
        redactEnv: env.LOG_REDACT ?? '',
        projectId: env.GCP_PROJECT_ID,
    };
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/config.spec.ts
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/config.ts packages/service/src/common/logger/config.spec.ts
git commit -m "feat(logger): Validate LOG_* env vars at startup"
```

---

## Task 7: `logAudit` and `logError` helpers

**Files:**
- Create: `packages/service/src/common/logger/helpers.ts`
- Create: `packages/service/src/common/logger/helpers.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/logger/helpers.spec.ts`:

```ts
import { logAudit, logError, ERROR_REPORTING_TYPE } from './helpers';

type Captured = { args: unknown[]; level: string };

function makeLogger() {
    const captured: Captured[] = [];
    const make = (level: string) => (...args: unknown[]) => { captured.push({ level, args }); };
    return {
        captured,
        log: make('info'),
        warn: make('warn'),
        error: make('error'),
        // Fake NestJS Logger surface — only `log` and `error` are used.
    };
}

describe('logAudit', () => {
    it('emits at info with audit: true and event name', () => {
        const logger = makeLogger();
        logAudit(logger as any, 'job.scheduled', { jobId: 'j1', target: 'https://x' });
        expect(logger.captured).toHaveLength(1);
        const entry = logger.captured[0];
        expect(entry.level).toBe('info');
        expect(entry.args[0]).toEqual({
            audit: true,
            event: 'job.scheduled',
            jobId: 'j1',
            target: 'https://x',
        });
        expect(entry.args[1]).toBe('job.scheduled');
    });
});

describe('logError', () => {
    it('emits at error with @type, message, and stack_trace for Error instance', () => {
        const logger = makeLogger();
        const err = new Error('boom');
        logError(logger as any, err, { jobId: 'j1' });
        const entry = logger.captured[0];
        expect(entry.level).toBe('error');
        const payload = entry.args[0] as Record<string, unknown>;
        expect(payload['@type']).toBe(ERROR_REPORTING_TYPE);
        expect(payload.message).toBe('boom');
        expect(payload.stack_trace).toContain('Error: boom');
        expect(payload.jobId).toBe('j1');
    });

    it('handles non-Error thrown values gracefully', () => {
        const logger = makeLogger();
        logError(logger as any, 'just a string', {});
        const payload = logger.captured[0].args[0] as Record<string, unknown>;
        expect(payload.message).toBe('just a string');
        expect(payload.stack_trace).toBeUndefined();
        expect(payload['@type']).toBe(ERROR_REPORTING_TYPE);
    });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd packages/service && yarn jest src/common/logger/helpers.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

Create `packages/service/src/common/logger/helpers.ts`:

```ts
import type { LoggerService } from '@nestjs/common';

export const ERROR_REPORTING_TYPE =
    'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

export function logAudit(
    logger: LoggerService,
    event: string,
    fields: Record<string, unknown>,
): void {
    logger.log({ audit: true, event, ...fields }, event);
}

export function logError(
    logger: LoggerService,
    err: unknown,
    fields: Record<string, unknown>,
): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack_trace = err instanceof Error ? err.stack : undefined;
    logger.error(
        {
            '@type': ERROR_REPORTING_TYPE,
            message,
            ...(stack_trace ? { stack_trace } : {}),
            ...fields,
        },
        message,
    );
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/logger/helpers.spec.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/logger/helpers.ts packages/service/src/common/logger/helpers.spec.ts
git commit -m "feat(logger): Add logAudit and logError helpers"
```

---

## Task 8: `TraceContextMiddleware`

**Files:**
- Create: `packages/service/src/common/middleware/trace-context.middleware.ts`
- Create: `packages/service/src/common/middleware/trace-context.middleware.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/service/src/common/middleware/trace-context.middleware.spec.ts`:

```ts
import { TraceContextMiddleware } from './trace-context.middleware';

describe('TraceContextMiddleware', () => {
    const originalProject = process.env.GCP_PROJECT_ID;

    afterEach(() => {
        if (originalProject === undefined) delete process.env.GCP_PROJECT_ID;
        else process.env.GCP_PROJECT_ID = originalProject;
    });

    it('attaches parsed fields to req.traceContext when header present', () => {
        process.env.GCP_PROJECT_ID = 'test-proj';
        const mw = new TraceContextMiddleware();
        const req: any = { headers: { 'x-cloud-trace-context': 'abc/12;o=1' } };
        const next = jest.fn();
        mw.use(req, {} as any, next);
        expect(req.traceContext).toEqual({
            'logging.googleapis.com/trace': 'projects/test-proj/traces/abc',
            'logging.googleapis.com/spanId': '12',
            'logging.googleapis.com/trace_sampled': true,
        });
        expect(next).toHaveBeenCalled();
    });

    it('sets req.traceContext to {} when header absent', () => {
        const mw = new TraceContextMiddleware();
        const req: any = { headers: {} };
        const next = jest.fn();
        mw.use(req, {} as any, next);
        expect(req.traceContext).toEqual({});
        expect(next).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd packages/service && yarn jest src/common/middleware/trace-context.middleware.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `packages/service/src/common/middleware/trace-context.middleware.ts`:

```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { parseCloudTrace, CloudTraceFields } from '../logger/trace';

declare module 'express-serve-static-core' {
    interface Request {
        traceContext?: CloudTraceFields;
    }
}

@Injectable()
export class TraceContextMiddleware implements NestMiddleware {
    use(req: Request, _res: Response, next: NextFunction) {
        const header = req.headers['x-cloud-trace-context'] as string | undefined;
        req.traceContext = parseCloudTrace(header, process.env.GCP_PROJECT_ID);
        next();
    }
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cd packages/service && yarn jest src/common/middleware/trace-context.middleware.spec.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/common/middleware/trace-context.middleware.ts packages/service/src/common/middleware/trace-context.middleware.spec.ts
git commit -m "feat(logger): Parse X-Cloud-Trace-Context into req.traceContext"
```

---

## Task 9: `LoggerModule` wiring

**Files:**
- Create: `packages/service/src/common/logger/logger.module.ts`

**Note:** This module has no unit test of its own — its behavior is validated end-to-end in Task 13 (integration test). The module is a thin adapter that composes pieces already unit-tested in Tasks 2–7.

- [ ] **Step 1: Create the module**

Create `packages/service/src/common/logger/logger.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { readLoggerEnv } from './config';
import { buildRedactPaths } from './redact';
import { levelToSeverity } from './severity';
import { makeSampler } from './sampler';

@Module({
    imports: [
        PinoLoggerModule.forRootAsync({
            useFactory: () => {
                const cfg = readLoggerEnv(process.env);

                return {
                    pinoHttp: {
                        level: cfg.level,
                        messageKey: 'message',
                        formatters: {
                            level: (label: string) => ({ severity: levelToSeverity(label) }),
                        },
                        redact: { paths: buildRedactPaths(cfg.redactEnv), censor: '[REDACTED]' },
                        hooks: { logMethod: makeSampler(cfg.sampleRate) },
                        customProps: (req: any) => ({
                            requestId: req.headers['x-request-id'],
                            ...(req.traceContext ?? {}),
                        }),
                        ...(cfg.includeSource
                            ? {
                                  mixin: () => {
                                      const err = new Error();
                                      const frame = (err.stack ?? '').split('\n')[3] ?? '';
                                      const match = /at\s+(\S+)\s+\(([^:]+):(\d+):\d+\)/.exec(frame);
                                      return match
                                          ? {
                                                'logging.googleapis.com/sourceLocation': {
                                                    function: match[1],
                                                    file: match[2],
                                                    line: match[3],
                                                },
                                            }
                                          : {};
                                  },
                              }
                            : {}),
                        ...(cfg.format === 'pretty'
                            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
                            : {}),
                    },
                };
            },
        }),
    ],
    exports: [PinoLoggerModule],
})
export class LoggerModule {}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/service/src/common/logger/logger.module.ts
git commit -m "feat(logger): Add LoggerModule wiring pino config"
```

---

## Task 10: Wire `LoggerModule` into `AppModule` + `main.ts`

**Files:**
- Modify: `packages/service/src/app.module.ts`
- Modify: `packages/service/src/main.ts`

- [ ] **Step 1: Update `app.module.ts`**

Replace the current `AppModule` content with:

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JobSchedulingModule } from './modules/job-scheduling/job-scheduling.module';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import KeyvRedis from '@keyv/redis';
import KeyvMongo from '@keyv/mongo';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TraceContextMiddleware } from './common/middleware/trace-context.middleware';
import { HealthController } from './common/controllers/health.controller';
import { LoggerModule } from './common/logger/logger.module';

const throttleTtl = Number(process.env.THROTTLE_TTL);
const throttleLimit = Number(process.env.THROTTLE_LIMIT);
const throttleEnabled = throttleTtl > 0 && throttleLimit > 0;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const required = ['AUTH_TOKEN'];
        const missing = required.filter((key) => !config[key]);
        if (missing.length > 0) {
          throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }
        return config;
      },
    }),
    LoggerModule,
    ...(throttleEnabled
      ? [ThrottlerModule.forRoot({ throttlers: [{ ttl: throttleTtl, limit: throttleLimit }] })]
      : []),
    CacheModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const storeType = configService.get<string>('CACHE_STORE', 'redis');

        let store;
        if (storeType === 'mongo') {
          const mongoUrl = configService.get<string>('MONGO_URL', 'mongodb://localhost:27017');
          const mongoDb = configService.get<string>('MONGO_DB', 'notitia');
          store = new KeyvMongo(mongoUrl, { db: mongoDb, collection: 'cache' });
        } else {
          const host = configService.get<string>('REDIS_HOST', 'localhost');
          const port = configService.get<number>('REDIS_PORT', 6379);
          store = new KeyvRedis(`redis://${host}:${port}`);
        }

        return { stores: [store] };
      },
      inject: [ConfigService],
      isGlobal: true,
    }),
    JobSchedulingModule,
  ],
  controllers: [HealthController],
  providers: [
    ...(throttleEnabled ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, TraceContextMiddleware)
      .forRoutes('*');
  }
}
```

- [ ] **Step 2: Update `main.ts`**

Replace the content of `packages/service/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto } from './common/dto/schedule-request.dto';
import { ScheduleJobResponseDto } from './common/dto/schedule-job-response.dto';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import helmet from 'helmet';
import { json } from 'express';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.useLogger(app.get(Logger));

    app.use(helmet());
    app.use(json({ limit: '1mb' }));

    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }));

    app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

    const config = new DocumentBuilder()
        .setTitle('Notitia API')
        .setDescription(
            'API for emitting events immediately, scheduled, or recurring. '
        )
        .setVersion('1.0')
        .build();

    const document = SwaggerModule.createDocument(app, config, {
        extraModels: [ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto, ScheduleJobResponseDto]
    });
    SwaggerModule.setup('docs', app, document);

    const port = process.env.PORT || 3000;
    await app.listen(port);
}
bootstrap();
```

`bufferLogs: true` + `app.useLogger(...)` is the idiomatic pattern for replacing the default logger without losing bootstrap logs.

- [ ] **Step 3: Smoke-build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 4: Smoke-start**

```bash
cd packages/service && AUTH_TOKEN=test SCHEDULER_TYPE=in-memory PORT=60099 LOG_FORMAT=json node dist/main &
sleep 2
curl -s http://localhost:60099/health
kill %1 2>/dev/null
```

Expected: one JSON-formatted log line on stdout containing `"message":"Nest application successfully started"` and the health endpoint returns `{"status":"ok"}`.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/app.module.ts packages/service/src/main.ts
git commit -m "feat(logger): Replace default NestJS logger with pino"
```

---

## Task 11: Migrate `AllExceptionsFilter` to `logError`

**Files:**
- Modify: `packages/service/src/common/filters/all-exceptions.filter.ts`

- [ ] **Step 1: Replace filter body**

Replace file contents with:

```ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { Response, Request } from 'express';
import { logError } from '../logger/helpers';

/**
 * Catches any exception NOT handled by HttpExceptionFilter.
 * Returns a generic 500 to prevent stack traces / internal details leaking to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        logError(this.logger, exception, {
            path: request.url,
            method: request.method,
        });

        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            timestamp: new Date().toISOString(),
            message: 'Internal server error',
        });
    }
}
```

- [ ] **Step 2: Build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/service/src/common/filters/all-exceptions.filter.ts
git commit -m "refactor(logger): Route unhandled exceptions via logError"
```

---

## Task 12: Migrate `HttpExceptionFilter` to `logError`

**Files:**
- Modify: `packages/service/src/common/filters/http-exception.filter.ts`

- [ ] **Step 1: Replace filter body**

```ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { logError } from '../logger/helpers';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: HttpException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const status = exception.getStatus();
        const exceptionResponse = exception.getResponse();

        let messageDetail: any = 'Internal server error';
        if (typeof exceptionResponse === 'string') {
            messageDetail = exceptionResponse;
        } else if (exceptionResponse && typeof exceptionResponse === 'object') {
            messageDetail = (exceptionResponse as any).message || exception.message;
        } else {
            messageDetail = exception.message;
        }

        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            method: request.method,
            message: messageDetail,
            ...(status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0 && { body: request.body }),
        };

        logError(this.logger, exception, {
            status,
            path: request.url,
            method: request.method,
            detail: messageDetail,
            ...(status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0
                ? { requestBody: request.body }
                : {}),
        });

        response.status(status).json(errorResponse);
    }
}
```

- [ ] **Step 2: Build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/service/src/common/filters/http-exception.filter.ts
git commit -m "refactor(logger): Route HttpException logs via logError"
```

---

## Task 13: Migrate `JobSchedulingController` audit lines

**Files:**
- Modify: `packages/service/src/modules/job-scheduling/job-scheduling.controller.ts`

- [ ] **Step 1: Read the current file**

```bash
cat packages/service/src/modules/job-scheduling/job-scheduling.controller.ts
```

Find the two lines currently using `[audit] scheduled ...` and `[audit] cancel ...`.

- [ ] **Step 2: Replace line ~58 (the "scheduled" audit log)**

Add import near top of file:

```ts
import { logAudit } from '../../common/logger/helpers';
```

Replace the existing:

```ts
this.logger.log(`[audit] scheduled job=${jobId} target=${safeUrl(scheduleRequestDto.target)} method=${scheduleRequestDto.method || 'POST'} schedule=${scheduleRequestDto.schedule?.type || 'immediate'}`);
```

with:

```ts
logAudit(this.logger, 'job.scheduled', {
    jobId,
    target: safeUrl(scheduleRequestDto.target),
    method: scheduleRequestDto.method || 'POST',
    schedule: scheduleRequestDto.schedule?.type || 'immediate',
});
```

- [ ] **Step 3: Replace line ~72 (the "cancel" audit log)**

Replace:

```ts
this.logger.log(`[audit] cancel job=${jobId} queue=${queue || 'default'} result=${result ? 'cancelled' : 'not_found'}`);
```

with:

```ts
logAudit(this.logger, 'job.cancelled', {
    jobId,
    queue: queue || 'default',
    result: result ? 'cancelled' : 'not_found',
});
```

- [ ] **Step 4: Build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/service/src/modules/job-scheduling/job-scheduling.controller.ts
git commit -m "refactor(logger): Emit audit events as structured records"
```

---

## Task 14: Fix `JobSchedulingService.scheduleJobProcessing` broken 2-arg log

**Files:**
- Modify: `packages/service/src/modules/job-scheduling/job-scheduling.service.ts`

The current line 16 passes the whole DTO as the second argument, which NestJS treats as the log context string. With pino underneath, that second arg would be stringified poorly or ignored. We rewrite it to put structured fields in the first-arg object.

- [ ] **Step 1: Replace the broken line**

Replace:

```ts
this.logger.log('received-job-scheduling', scheduleRequestDto);
```

with:

```ts
this.logger.log(
    {
        event: 'received-job-scheduling',
        target: scheduleRequestDto.target,
        method: scheduleRequestDto.method,
        schedule: scheduleRequestDto.schedule?.type ?? 'immediate',
        queue: scheduleRequestDto.queue,
    },
    'received-job-scheduling',
);
```

(We intentionally omit the full `scheduleRequestDto` because its `payload` field may contain sensitive user data; the four above fields are the audit-relevant ones.)

- [ ] **Step 2: Also modernize the two other `log` calls in this file**

Replace:

```ts
this.logger.log(`received-cancel-job-scheduling: ${jobId} @ ${queue}`);
```

with:

```ts
this.logger.log({ event: 'received-cancel-job-scheduling', jobId, queue }, 'received-cancel-job-scheduling');
```

Replace:

```ts
this.logger.log(`job-cancelled: ${jobId} @ ${queue}`);
```

with:

```ts
this.logger.log({ event: 'job-cancelled', jobId, queue }, 'job-cancelled');
```

Replace:

```ts
this.logger.warn(`job-not-found: ${jobId} @ ${queue}`);
```

with:

```ts
this.logger.warn({ event: 'job-not-found', jobId, queue }, 'job-not-found');
```

- [ ] **Step 3: Build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/service/src/modules/job-scheduling/job-scheduling.service.ts
git commit -m "fix(logger): Restructure JobSchedulingService logs; drop DTO leak"
```

---

## Task 15: Migrate `HttpExecutorService` success/failure logs

**Files:**
- Modify: `packages/service/src/common/services/http-executor.service.ts`

- [ ] **Step 1: Replace the "Dropping header" warn**

Replace:

```ts
this.logger.warn(`[${taskId}] Dropping header "${name.replace(/[\r\n]/g, '')}" — contains CRLF`);
```

with:

```ts
this.logger.warn(
    { jobId: taskId, header: name.replace(/[\r\n]/g, ''), reason: 'crlf' },
    'Dropping header with CRLF',
);
```

- [ ] **Step 2: Replace the "Executing" log**

Replace:

```ts
this.logger.log(`[${taskId}] Executing ${method} ${safeUrl(target)}`);
```

with:

```ts
this.logger.log(
    { jobId: taskId, method, target: safeUrl(target), sampleable: true },
    'Executing',
);
```

- [ ] **Step 3: Replace the "Success" log**

Replace:

```ts
this.logger.log(`[${taskId}] Success ${response.status} (${duration}ms)`);
```

with:

```ts
this.logger.log(
    { jobId: taskId, status: response.status, durationMs: duration, sampleable: true },
    'Success',
);
```

- [ ] **Step 4: Replace the axios-error path**

Replace:

```ts
this.logger.error(`[${taskId}] Failed ${status || 'NETWORK'} (${duration}ms): ${error.message}${errorData ? ` - ${JSON.stringify(errorData)}` : ''}`);
```

with:

```ts
this.logger.error(
    {
        jobId: taskId,
        status: status ?? 'NETWORK',
        durationMs: duration,
        error: error.message,
        ...(errorData ? { responseBody: errorData } : {}),
    },
    'Failed',
);
```

- [ ] **Step 5: Replace the unknown-error path**

Replace:

```ts
this.logger.error(`[${taskId}] Failed UNKNOWN (${duration}ms): ${error instanceof Error ? error.message : String(error)}`);
```

with:

```ts
this.logger.error(
    {
        jobId: taskId,
        status: 'UNKNOWN',
        durationMs: duration,
        error: error instanceof Error ? error.message : String(error),
    },
    'Failed',
);
```

- [ ] **Step 6: Build**

```bash
cd packages/service && yarn build
```

Expected: clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/service/src/common/services/http-executor.service.ts
git commit -m "refactor(logger): Structure HttpExecutorService logs + enable sampling"
```

---

## Task 16: Integration test — capture stdout, assert JSON shape

**Files:**
- Create: `packages/service/src/common/logger/logger.integration.spec.ts`

**Background:** We verify the full pipeline by booting a real `AppModule` with pino piped to a captured writable stream, firing a request via `supertest`, and parsing captured JSON lines. `pino-http` accepts a `stream` option that we can pass via `pinoHttp`.

Rather than mutating the module, we use pino's in-process testing helper: we wrap the running logger's `streamSym` — but the simpler approach is to intercept `process.stdout.write` for the duration of the test.

- [ ] **Step 1: Write the integration test**

Create `packages/service/src/common/logger/logger.integration.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, Controller, Get } from '@nestjs/common';
import { Logger as PinoLogger, LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { buildRedactPaths } from './redact';
import { levelToSeverity } from './severity';
import { makeSampler } from './sampler';
import { parseCloudTrace } from './trace';
import { RequestIdMiddleware } from '../middleware/request-id.middleware';
import { TraceContextMiddleware } from '../middleware/trace-context.middleware';
import { logAudit, logError, ERROR_REPORTING_TYPE } from './helpers';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';

@Controller()
class TestController {
    private readonly logger = new (require('@nestjs/common').Logger)(TestController.name);

    @Get('ping')
    ping() {
        this.logger.log({ foo: 'bar' }, 'ping');
        return { ok: true };
    }

    @Get('audit')
    audit() {
        logAudit(this.logger, 'test.event', { x: 1 });
        return { ok: true };
    }

    @Get('boom')
    boom() {
        logError(this.logger, new Error('kaboom'), { path: '/boom' });
        return { ok: true };
    }
}

@Module({
    imports: [
        PinoLoggerModule.forRoot({
            pinoHttp: {
                level: 'info',
                messageKey: 'message',
                formatters: { level: (label: string) => ({ severity: levelToSeverity(label) }) },
                redact: { paths: buildRedactPaths(''), censor: '[REDACTED]' },
                hooks: { logMethod: makeSampler(1.0) },
                customProps: (req: any) => ({
                    requestId: req.headers['x-request-id'],
                    ...(req.traceContext ?? {}),
                }),
            },
        }),
    ],
    controllers: [TestController],
})
class TestAppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(RequestIdMiddleware, TraceContextMiddleware).forRoutes('*');
    }
}

describe('Logger integration', () => {
    let app: INestApplication;
    let captured: string[];
    let originalWrite: typeof process.stdout.write;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({
            imports: [TestAppModule],
        }).compile();
        app = moduleRef.createNestApplication({ bufferLogs: true });
        app.useLogger(app.get(PinoLogger));
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        captured = [];
        originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: any, ...rest: any[]) => {
            const str = typeof chunk === 'string' ? chunk : chunk.toString();
            captured.push(str);
            return originalWrite(chunk, ...rest);
        }) as typeof process.stdout.write;
    });

    afterEach(() => {
        process.stdout.write = originalWrite;
    });

    function parsedLines(): Array<Record<string, unknown>> {
        return captured
            .flatMap((c) => c.split('\n'))
            .filter((s) => s.trim().startsWith('{'))
            .map((s) => {
                try { return JSON.parse(s); } catch { return null; }
            })
            .filter((v): v is Record<string, unknown> => v !== null);
    }

    it('emits structured JSON with severity mapped from pino level', async () => {
        await request(app.getHttpServer()).get('/ping').expect(200);
        const lines = parsedLines();
        const appLog = lines.find((l) => l.message === 'ping');
        expect(appLog).toBeDefined();
        expect(appLog!.severity).toBe('INFO');
        expect(appLog!.foo).toBe('bar');
        expect(appLog!.context).toBe('TestController');
    });

    it('attaches requestId and trace fields when X-Cloud-Trace-Context is present', async () => {
        await request(app.getHttpServer())
            .get('/ping')
            .set('X-Request-ID', 'test-req-1')
            .set('X-Cloud-Trace-Context', 'abc123/99;o=1')
            .expect(200);

        const lines = parsedLines();
        const appLog = lines.find((l) => l.message === 'ping' && l.requestId === 'test-req-1');
        expect(appLog).toBeDefined();
        expect(appLog!['logging.googleapis.com/trace']).toContain('abc123');
        expect(appLog!['logging.googleapis.com/spanId']).toBe('99');
        expect(appLog!['logging.googleapis.com/trace_sampled']).toBe(true);
    });

    it('emits audit: true with event name', async () => {
        await request(app.getHttpServer()).get('/audit').expect(200);
        const lines = parsedLines();
        const auditLog = lines.find((l) => l.audit === true);
        expect(auditLog).toBeDefined();
        expect(auditLog!.event).toBe('test.event');
        expect(auditLog!.x).toBe(1);
    });

    it('error logs carry the Error Reporting @type and a stack_trace', async () => {
        await request(app.getHttpServer()).get('/boom').expect(200);
        const lines = parsedLines();
        const errLog = lines.find((l) => l['@type'] === ERROR_REPORTING_TYPE);
        expect(errLog).toBeDefined();
        expect(errLog!.severity).toBe('ERROR');
        expect(errLog!.message).toBe('kaboom');
        expect(typeof errLog!.stack_trace).toBe('string');
    });

    it('redacts authorization header in request logs', async () => {
        await request(app.getHttpServer())
            .get('/ping')
            .set('Authorization', 'Bearer SHOULD_NOT_APPEAR')
            .expect(200);
        const joined = captured.join('');
        expect(joined).not.toContain('SHOULD_NOT_APPEAR');
        expect(joined).toContain('[REDACTED]');
    });
});
```

- [ ] **Step 2: Install supertest types if missing**

```bash
cd packages/service && yarn list --pattern supertest 2>/dev/null
```

`supertest` and `@types/supertest` are already listed in `devDependencies` — no action needed.

- [ ] **Step 3: Run the integration test**

```bash
cd packages/service && yarn jest src/common/logger/logger.integration.spec.ts --runInBand
```

Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/service/src/common/logger/logger.integration.spec.ts
git commit -m "test(logger): Integration test for pino pipeline end-to-end"
```

---

## Task 17: Full test suite + manual smoke

**Files:** none modified

- [ ] **Step 1: Run the full test suite**

```bash
cd packages/service && yarn test
```

Expected: all tests pass. (~30+ assertions across the logger unit specs + the 5 integration cases.)

- [ ] **Step 2: Smoke-test the dev server in pretty mode**

```bash
cd packages/service && LOG_FORMAT=pretty LOG_LEVEL=debug AUTH_TOKEN=test SCHEDULER_TYPE=in-memory PORT=60099 yarn build && \
    LOG_FORMAT=pretty LOG_LEVEL=debug AUTH_TOKEN=test SCHEDULER_TYPE=in-memory PORT=60099 node dist/main &
sleep 2
curl -s -X POST http://localhost:60099/schedule \
    -H 'Content-Type: application/json' \
    -d '{"target":"http://localhost:60099/health"}' 
kill %1 2>/dev/null
```

Expected: human-readable log output during bootstrap; a `job.scheduled` audit line with structured fields.

- [ ] **Step 3: Smoke-test the dev server in json mode**

```bash
cd packages/service && LOG_FORMAT=json LOG_LEVEL=info AUTH_TOKEN=test SCHEDULER_TYPE=in-memory PORT=60099 node dist/main 2>&1 | head -20
```

Kill with Ctrl-C after 5 seconds. Expected: first 20 lines are all valid JSON, each containing `severity`, `message`, `context`.

No commit for this task — it's a verification-only step.

---

## Task 18: Document env vars in service README + docker-compose

**Files:**
- Modify: `packages/service/README.md`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Extend the env-var table in `packages/service/README.md`**

In the "Environment Variables" table, add these rows (keep alphabetized within the logging block):

```markdown
| `LOG_LEVEL` | No | `info` (prod) / `debug` (dev) | Minimum log level: `trace|debug|info|warn|error|fatal` |
| `LOG_FORMAT` | No | `json` (prod) / `pretty` (dev) | Output format. `json` for Cloud Logging ingestion; `pretty` for local dev. |
| `LOG_SAMPLE_RATE` | No | `1.0` | Fraction (0.0–1.0) of high-volume successful-execution logs to keep. Warnings, errors, and audit events are never sampled. |
| `LOG_REDACT` | No | — | Comma-separated pino redact paths, appended to built-in defaults (authorization/cookie/password/token/secret are always redacted). |
| `LOG_INCLUDE_SOURCE` | No | `false` | When `true` (or when `LOG_LEVEL=debug`), include `logging.googleapis.com/sourceLocation` on every log line. Has a small capture cost. |
```

Also add a short "Logging" subsection right after the env-var table:

```markdown
### Logging

The service emits structured JSON on stdout in production, with GCP-native keys (`severity`, `logging.googleapis.com/trace`, etc). Cloud Logging ingests each line as a `jsonPayload`. Errors carry the Error Reporting `@type` marker and auto-group into incidents. Audit events (`job.scheduled`, `job.cancelled`) emit `audit: true` and an `event` field, making a `jsonPayload.audit=true` sink trivial to build.

During development, set `LOG_FORMAT=pretty` (the default when `NODE_ENV !== 'production'`) for human-readable single-line output.
```

- [ ] **Step 2: Add commented examples to `docker-compose.yml`**

In the `service` block's `environment:` list, after the existing `DEFAULT_TIMEOUT_SECONDS` comments, append:

```yaml
      # Structured logging (optional; sensible defaults apply):
      # - LOG_LEVEL=info
      # - LOG_FORMAT=json
      # - LOG_SAMPLE_RATE=1.0
      # - LOG_REDACT=
      # - LOG_INCLUDE_SOURCE=false
```

- [ ] **Step 3: Commit**

```bash
git add packages/service/README.md docker-compose.yml
git commit -m "docs(logger): Document LOG_* env vars and GCP logging behavior"
```

---

## Task 19: Python SDK logging doc

**Files:**
- Create: `packages/python-sdk/docs/logging.md`

- [ ] **Step 1: Create the doc**

Create `packages/python-sdk/docs/logging.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/python-sdk/docs/logging.md
git commit -m "docs(sdk): Document GCP-compatible logging formatter for SDK users"
```

---

## Task 20: Knowledge base update

**Files:**
- Create: `packages/service/.knowledge/subsystems/logging.md` → actually lives at repo root `.knowledge/subsystems/logging.md`

Per the repo's `CLAUDE.md`, `.knowledge/` lives at repo root and is self-maintained.

- [ ] **Step 1: Create the knowledge file**

Create `/home/nick/projects/notitia/.knowledge/subsystems/logging.md`:

```markdown
---
description: Structured logging via nestjs-pino — env-driven control, GCP-native fields, request correlation, audit and Error Reporting routing
---

# Subsystem: Logging

## Scope

The service uses `nestjs-pino` as its sole `LoggerService`. All logs emit as single-line JSON on stdout in production; `pino-pretty` is used in dev when `LOG_FORMAT=pretty`. Lives under `packages/service/src/common/logger/`.

## Responsibilities

- Emit GCP-native log records: `severity`, `message`, `logging.googleapis.com/trace|spanId|trace_sampled|sourceLocation`.
- Correlate every log line inside an HTTP request with `requestId` (from `RequestIdMiddleware`) and trace fields (from `TraceContextMiddleware` parsing `X-Cloud-Trace-Context`).
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
- `logError(this.logger, err, { jobId, ... })` — error-level with stack.
- Tag `sampleable: true` only on high-volume success logs (currently only `HttpExecutorService` `Executing` / `Success` pair).

## Key files

- `common/logger/logger.module.ts` — NestJS module, pino config.
- `common/logger/config.ts` — env reader + validator.
- `common/logger/trace.ts` — `parseCloudTrace`.
- `common/logger/sampler.ts` — level-aware sampling hook.
- `common/logger/redact.ts` — default + user redact path builder.
- `common/logger/severity.ts` — pino-label → GCP-severity mapping.
- `common/logger/helpers.ts` — `logAudit` / `logError`.
- `common/middleware/trace-context.middleware.ts` — parses `X-Cloud-Trace-Context` after `RequestIdMiddleware`.

## Related

- [API Contract](../conventions/api-contract.md) — endpoints that emit audit logs.
- [System Overview](../architecture/system-overview.md) — hardening and middleware chain.
```

- [ ] **Step 2: Commit**

```bash
git add .knowledge/subsystems/logging.md
git commit -m "docs(knowledge): Describe logging subsystem"
```

---

## Self-Review

**Spec coverage:** every section of the spec has at least one task covering it.

- Architecture (new files) → Tasks 2–9.
- Canonical record shape → Tasks 2–7 cover individual fields; Task 16 asserts the composed shape.
- Request-scoped context → Task 8 (middleware) + Task 10 (wiring) + Task 16 (asserts fields on emitted records).
- Configuration surface → Task 6 (validation) + Task 18 (docs).
- Sampling → Task 5 (unit) + Task 15 (tagging sites) + Task 16 (implicit via sampler=1.0 in test).
- Redaction → Task 4 (paths) + Task 16 (asserts redaction end-to-end).
- Audit logs → Task 7 (helper) + Task 13 (call sites) + Task 16 (asserts shape).
- Error Reporting → Task 7 + Task 11/12 (filter integration) + Task 16 (asserts `@type`).
- Migration plan — forced sites → Tasks 11, 12, 13, 14, 15.
- Python SDK docs → Task 19.
- Testing strategy → Tasks 2–8 (unit) + Task 16 (integration) + Task 17 (full suite + smoke).
- Rollout — infra lands first, migrations follow → Task order enforces this.

**Placeholder scan:** none found. All code blocks are complete; no "TBD", "similar to Task N", or hand-waving.

**Type consistency:**
- `LoggerConfig` fields match between Tasks 6 and 9.
- `CloudTraceFields` used in Tasks 2 and 8.
- `logAudit` / `logError` signatures match across Tasks 7, 11, 12, 13.
- `ERROR_REPORTING_TYPE` constant referenced from helpers in Task 7 and asserted in Task 16.
- `sampleable: true` flag emitted in Task 15 and interpreted by sampler in Task 5.
- `audit: true` flag emitted in Task 7 (`logAudit`) and interpreted by sampler in Task 5.
