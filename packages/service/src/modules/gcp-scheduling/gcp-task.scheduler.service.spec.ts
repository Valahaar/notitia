import { ConflictException, HttpException, Logger } from '@nestjs/common';
import { GcpTaskSchedulerService, deriveUfid } from './gcp-task.scheduler.service';
import { CloudTasksClientHolder } from './cloud-tasks-client.holder';
import { taskNameFor } from './task-name';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';

jest.mock('@google-cloud/tasks', () => ({
    CloudTasksClient: jest.fn().mockImplementation(() => ({})),
}));

const INVALID_ARGUMENT = 3;
const UNAVAILABLE = 14;

const grpcError = (code: number, extra: Record<string, unknown> = {}) => ({
    code,
    details: 'Request contains an invalid argument.',
    message: `${code} GRPC_ERROR: Request contains an invalid argument.`,
    ...extra,
});

function makeService(createTask: jest.Mock) {
    const config = {
        get: (key: string) =>
            ({
                GCP_PROJECT_ID: 'proj',
                GCP_LOCATION_ID: 'europe-west8',
                GCP_JOB_QUEUE_NAME: 'jobs',
                NOTIFICATION_SERVICE_URL: 'https://notitia.test',
                AUTH_TOKEN: 'token',
            })[key],
    };
    const service = new GcpTaskSchedulerService(config as any, {} as any, {} as any);
    const fakeClient = {
        queuePath: () => 'projects/proj/locations/europe-west8/queues/jobs',
        taskPath: (p: string, l: string, q: string, t: string) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
        createTask,
        close: jest.fn(),
    };
    (service as any).clientHolder = new CloudTasksClientHolder(() => fakeClient as any);
    return service;
}

// Runs createTask to completion while fake timers drive any backoff sleeps.
async function run(service: GcpTaskSchedulerService) {
    const settled = service
        .createTask('jobs', 'https://notitia.test/relay', { a: 1 }, undefined, 'tname')
        .then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
    await jest.runAllTimersAsync();
    return settled;
}

describe('GcpTaskSchedulerService.createTask', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('retries a bare INVALID_ARGUMENT and returns the task id once Cloud Tasks accepts it', async () => {
        const createTask = jest
            .fn()
            .mockRejectedValueOnce(grpcError(INVALID_ARGUMENT, { statusDetails: [] }))
            .mockResolvedValueOnce([{ name: 'projects/proj/locations/l/queues/jobs/tasks/123' }]);

        const result: any = await run(makeService(createTask));

        expect(result.value).toBe('123');
        expect(createTask).toHaveBeenCalledTimes(2);
    });

    it('does not retry INVALID_ARGUMENT when Cloud Tasks names the offending field', async () => {
        const violations = [{ fieldViolations: [{ field: 'task.http_request.url', description: 'bad' }] }];
        const createTask = jest
            .fn()
            .mockRejectedValue(grpcError(INVALID_ARGUMENT, { statusDetails: violations }));

        const result: any = await run(makeService(createTask));

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(result.error).toBeInstanceOf(HttpException);
        expect(result.error.getStatus()).toBe(400);
    });

    it('answers 503 (retryable by callers) once INVALID_ARGUMENT keeps failing after 3 attempts', async () => {
        const createTask = jest.fn().mockRejectedValue(grpcError(INVALID_ARGUMENT));

        const result: any = await run(makeService(createTask));

        expect(createTask).toHaveBeenCalledTimes(3);
        expect(result.error).toBeInstanceOf(HttpException);
        expect(result.error.getStatus()).toBe(503);
    });

    it('retries UNAVAILABLE and answers 503 once the budget is spent', async () => {
        const createTask = jest.fn().mockRejectedValue(grpcError(UNAVAILABLE));

        const result: any = await run(makeService(createTask));

        expect(createTask.mock.calls.length).toBeGreaterThan(1);
        expect(result.error.getStatus()).toBe(503);
    });

    it('names every task', async () => {
        const createTask = jest.fn().mockResolvedValue([{ name: 'projects/proj/locations/l/queues/jobs/tasks/tname' }]);
        const result: any = await run(makeService(createTask));

        expect(result.value).toBe('tname');
        expect(createTask.mock.calls[0][0].task.name).toMatch(/\/tasks\/tname$/);
    });

    it('treats ALREADY_EXISTS as success and returns the name', async () => {
        const createTask = jest.fn().mockRejectedValue({ code: 6, details: 'exists' });
        const result: any = await run(makeService(createTask));

        expect(result.error).toBeUndefined();
        expect(result.value).toBe('tname');
    });
});

describe('GcpTaskSchedulerService.scheduleJob naming', () => {
    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns the same id when the keyed task already exists', async () => {
        const createTask = jest
            .fn()
            .mockImplementationOnce(async ({ task }: any) => [{ name: task.name }])
            .mockRejectedValueOnce({ code: 6, details: 'exists' });
        const service = makeService(createTask);

        const req = { target: 'https://example.com/hook', idempotencyKey: 'k', queue: 'jobs' } as any;
        const first = await service.scheduleJob(req);
        const second = await service.scheduleJob(req);

        const expected = taskNameFor(['key', 'jobs', 'k']);
        expect(first).toBe(expected);
        expect(second).toBe(expected);
    });

    it('uses a fresh random name per request without a key', async () => {
        const createTask = jest.fn().mockImplementation(async ({ task }: any) => [{ name: task.name }]);
        const service = makeService(createTask);

        const req = { target: 'https://example.com/hook', queue: 'jobs' } as any;
        const a = await service.scheduleJob(req);
        const b = await service.scheduleJob(req);

        expect(a).not.toBe(b);
        expect(a).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe('GcpTaskSchedulerService occurrence', () => {
    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    const bodyOf = (createTask: jest.Mock, call = 0) =>
        JSON.parse(Buffer.from(createTask.mock.calls[call][0].task.httpRequest.body).toString());

    function makeRealHelperService(createTask: jest.Mock) {
        const service = makeService(createTask);
        (service as any).scheduleHelperService = new ScheduleHelperService();
        (service as any).cacheManager = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
        return service;
    }

    it('a scheduled direct relay carries X-Notitia-Occurrence', async () => {
        jest.useFakeTimers({ now: new Date('2026-11-16T10:00:00Z') });
        const createTask = jest.fn().mockImplementation(async ({ task }: any) => [{ name: task.name }]);
        const service = makeRealHelperService(createTask);

        await service.scheduleJob({
            target: 'https://example.com/hook',
            schedule: { type: 'on', time: '2026-12-01T09:00:00Z' },
        } as any);

        expect(bodyOf(createTask).headers).toMatchObject({ 'X-Notitia-Occurrence': '2026-12-01T09:00:00.000Z' });
    });

    it('an immediate request has no occurrence header', async () => {
        const createTask = jest.fn().mockImplementation(async ({ task }: any) => [{ name: task.name }]);
        const service = makeRealHelperService(createTask);

        await service.scheduleJob({ target: 'https://example.com/hook', headers: { A: 'b' } } as any);

        const headers = bodyOf(createTask).headers ?? {};
        expect(headers['X-Notitia-Occurrence']).toBeUndefined();
        expect(headers.A).toBe('b');
    });

    it('a recurring create sends occurrence and the anchored rule on the meta payload', async () => {
        jest.useFakeTimers({ now: new Date('2026-11-16T10:02:30Z') });
        const createTask = jest.fn().mockImplementation(async ({ task }: any) => [{ name: task.name }]);
        const service = makeRealHelperService(createTask);

        const ufid = await service.scheduleJob({
            target: 'https://example.com/hook',
            schedule: { type: 'recurring', schedule: 'RRULE:FREQ=HOURLY;INTERVAL=6', timezone: 'Europe/Rome' },
        } as any);

        expect(createTask.mock.calls[0][0].task.name.split('/').at(-1)).toBe(taskNameFor([ufid, 'create']));
        const body = bodyOf(createTask);
        expect(body.schedule.schedule).toBe('DTSTART;TZID=Europe/Rome:20261116T110230\nRRULE:FREQ=HOURLY;INTERVAL=6');
        expect(body.schedule.timezone).toBe('Europe/Rome');
        expect(body.occurrence).toBe('2026-11-16T16:02:30.000Z');
        expect(body.isOccurrence).toBe(true);
    });
});

// A real scheduler over a fake Cloud Tasks (a known name answers ALREADY_EXISTS) and a Map-backed cache.
function makeWorld(defaultQueue = 'jobs') {
    const existing = new Set<string>();
    const createTask = jest.fn().mockImplementation(async ({ task }: any) => {
        if (existing.has(task.name)) {
            throw { code: 6, details: 'Requested entity already exists' };
        }
        existing.add(task.name);
        return [{ name: task.name }];
    });
    const deleteTask = jest.fn().mockResolvedValue([{}]);
    const store = new Map<string, unknown>();
    const cache = {
        get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
        set: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
        del: jest.fn(async (key: string) => {
            store.delete(key);
        }),
    };
    const config = {
        get: (key: string) =>
            ({
                GCP_PROJECT_ID: 'proj',
                GCP_LOCATION_ID: 'europe-west8',
                GCP_JOB_QUEUE_NAME: defaultQueue,
                NOTIFICATION_SERVICE_URL: 'https://notitia.test',
                AUTH_TOKEN: 'token',
            })[key],
    };
    const scheduler = new GcpTaskSchedulerService(config as any, new ScheduleHelperService(), cache as any);
    (scheduler as any).clientHolder = new CloudTasksClientHolder(() => ({
        queuePath: (_p: string, _l: string, q: string) => `projects/proj/locations/l/queues/${q}`,
        taskPath: (_p: string, _l: string, q: string, t: string) => `projects/proj/locations/l/queues/${q}/tasks/${t}`,
        createTask,
        deleteTask,
        close: jest.fn(),
    }) as any);
    return { scheduler, createTask, deleteTask, cache, store };
}

describe('GcpTaskSchedulerService cancel and keyed schedules', () => {
    const UFID = '1234567890123456789';
    const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;
    const taskPath = (queue: string, name: string) => `projects/proj/locations/l/queues/${queue}/tasks/${name}`;
    const recurringReq = (extra: Record<string, unknown> = {}) =>
        ({
            target: 'https://example.com/hook',
            queue: 'jobs',
            schedule: { type: 'recurring', schedule: '0 * * * *' },
            ...extra,
        }) as any;

    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('tracks a schedule under one queue-independent key', async () => {
        const { scheduler, store } = makeWorld('default');

        const ufid = await scheduler.scheduleJob(recurringReq());

        expect(store.get(`gcp_job:${ufid}`)).toBe(taskPath('meta-jobs', taskNameFor([ufid, 'create'])));
        expect(store.has(`gcp_job:jobs:${ufid}`)).toBe(false);
        expect(store.has(`gcp_job:default:${ufid}`)).toBe(false);
    });

    it('cancel tombstones a known ufid for 60 days, deletes its tracked meta task and forgets it', async () => {
        const { scheduler, deleteTask, cache, store } = makeWorld('default');
        const ufid = await scheduler.scheduleJob(recurringReq());

        await expect(scheduler.cancelJob(ufid)).resolves.toBe(true);

        expect(cache.set).toHaveBeenCalledWith(`gcp_job:cancelled:${ufid}`, expect.anything(), SIXTY_DAYS_MS);
        await expect(scheduler.isTombstoned(ufid)).resolves.toBe(true);
        expect(deleteTask.mock.calls[0][0]).toEqual({ name: taskPath('meta-jobs', taskNameFor([ufid, 'create'])) });
        expect(store.has(`gcp_job:${ufid}`)).toBe(false);
    });

    it('cancel reads a tracked id stored by v1.3.4', async () => {
        const { scheduler, deleteTask, store } = makeWorld('jobs');
        store.set(`gcp_job:jobs:${UFID}`, '5550001');

        await expect(scheduler.cancelJob(UFID)).resolves.toBe(true);

        expect(deleteTask).toHaveBeenCalledTimes(1);
        expect(deleteTask.mock.calls[0][0]).toEqual({ name: taskPath('meta-jobs', '5550001') });
        await expect(scheduler.isTombstoned(UFID)).resolves.toBe(true);
        expect(store.has(`gcp_job:jobs:${UFID}`)).toBe(false);
    });

    it('cancel reads a v1.3.4 tracked id stored under the request queue', async () => {
        const { scheduler, deleteTask, store } = makeWorld('default');
        store.set(`gcp_job:jobs:${UFID}`, '5550001');

        await expect(scheduler.cancelJob(UFID, 'jobs')).resolves.toBe(true);

        expect(deleteTask.mock.calls[0][0]).toEqual({ name: taskPath('meta-jobs', '5550001') });
        await expect(scheduler.isTombstoned(UFID)).resolves.toBe(true);
    });

    it('cancel of a known ufid succeeds when its tracked meta task is already gone', async () => {
        const { scheduler, deleteTask } = makeWorld();
        const ufid = await scheduler.scheduleJob(recurringReq());
        deleteTask.mockRejectedValueOnce({ code: 5, details: 'not found' });

        await expect(scheduler.cancelJob(ufid)).resolves.toBe(true);
        await expect(scheduler.isTombstoned(ufid)).resolves.toBe(true);
    });

    it('cancel of an unknown id falls back to the direct task path', async () => {
        const { scheduler, deleteTask, cache } = makeWorld();

        await expect(scheduler.cancelJob('abc', 'jobs')).resolves.toBe(true);
        expect(deleteTask.mock.calls[0][0]).toEqual({ name: taskPath('jobs', 'abc') });

        deleteTask.mockRejectedValueOnce({ code: 5, details: 'not found' });
        await expect(scheduler.cancelJob('missing')).resolves.toBe(false);

        expect(cache.set).not.toHaveBeenCalled();
    });

    it('a keyed create retried returns the same schedule id', async () => {
        const { scheduler, createTask } = makeWorld();
        const req = recurringReq({ idempotencyKey: 'k' });

        const first = await scheduler.scheduleJob(req);
        const second = await scheduler.scheduleJob(req);

        expect(first).toMatch(/^\d{19}$/);
        expect(first).toBe(deriveUfid('k', 'jobs'));
        expect(second).toBe(first);
        expect(createTask).toHaveBeenCalledTimes(2);
        await expect(createTask.mock.results[1].value).rejects.toMatchObject({ code: 6 });
    });

    it('a keyed long one-off create retried returns the same schedule id', async () => {
        const { scheduler } = makeWorld();
        const req = {
            target: 'https://example.com/hook',
            queue: 'jobs',
            idempotencyKey: 'far',
            schedule: { type: 'on', time: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString() },
        } as any;

        const first = await scheduler.scheduleJob(req);

        expect(first).toBe(deriveUfid('far', 'jobs'));
        await expect(scheduler.scheduleJob(req)).resolves.toBe(first);
    });

    it('derives the ufid from the key and the queue', () => {
        expect(deriveUfid('k', 'jobs')).toBe(deriveUfid('k', 'jobs'));
        expect(deriveUfid('k', 'jobs')).not.toBe(deriveUfid('k', 'other'));
        expect(deriveUfid('k', 'jobs')).not.toBe(deriveUfid('k2', 'jobs'));
        expect(deriveUfid('k', 'other')).toMatch(/^\d{19}$/);
    });

    it('a keyed create after cancel is refused with 409', async () => {
        const { scheduler, createTask } = makeWorld();
        const req = recurringReq({ idempotencyKey: 'k' });
        const ufid = await scheduler.scheduleJob(req);
        await scheduler.cancelJob(ufid);

        const error = await scheduler.scheduleJob(req).catch((e) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getStatus()).toBe(409);
        expect(createTask).toHaveBeenCalledTimes(1);
    });
});
