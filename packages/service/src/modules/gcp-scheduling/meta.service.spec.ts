import { Logger } from '@nestjs/common';
import { MetaService } from './meta.service';
import { GcpTaskSchedulerService } from './gcp-task.scheduler.service';
import { CloudTasksClientHolder } from './cloud-tasks-client.holder';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { taskNameFor } from './task-name';

jest.mock('@google-cloud/tasks', () => ({
    CloudTasksClient: jest.fn().mockImplementation(() => ({})),
}));

const UFID = '1234567890123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

const metaName = (t: string) => taskNameFor([UFID, 'meta', t]);
const relayName = (t: string) => taskNameFor([UFID, 'relay', t]);
const deliveryOf = (t: string) => ({ taskName: metaName(t), etaSeconds: Math.floor(new Date(t).getTime() / 1000) });

// Scheduler stub: create calls resolve to the name they were given (as createTask does).
function makeScheduler() {
    return {
        getQueueName: jest.fn().mockReturnValue('jobs'),
        isTombstoned: jest.fn().mockResolvedValue(false),
        getIdFromUfid: jest.fn().mockResolvedValue('tracked-task'),
        setIdForUfid: jest.fn().mockResolvedValue(undefined),
        delUfid: jest.fn().mockResolvedValue(undefined),
        createRelayEndpointTask: jest.fn().mockImplementation(async (_req: unknown, _at: unknown, name: string) => name),
        createMetaEndpointTask: jest.fn().mockImplementation(async (_ufid: unknown, _req: unknown, _at: unknown, name: string) => name),
        withOccurrenceHeader: GcpTaskSchedulerService.prototype.withOccurrenceHeader,
    };
}

function makeService(scheduler = makeScheduler()) {
    return { scheduler, service: new MetaService(scheduler as any, new ScheduleHelperService()) };
}

/**
 * A real scheduler and MetaService over a fake Cloud Tasks (a known name answers ALREADY_EXISTS)
 * and a Map-backed cache. `onCreate` runs before each create, so a test can act mid-delivery.
 */
function makeWorld(defaultQueue = 'jobs') {
    const existing = new Set<string>();
    const hooks: { onCreate?: (taskPath: string) => Promise<void> } = {};
    const createTask = jest.fn().mockImplementation(async ({ task }: any) => {
        await hooks.onCreate?.(task.name);
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
    const service = new MetaService(scheduler, new ScheduleHelperService());

    const created = () =>
        createTask.mock.calls.map(([{ task }]: any) => ({
            queue: task.name.split('/')[5] as string,
            name: task.name.split('/').at(-1) as string,
            body: JSON.parse(Buffer.from(task.httpRequest.body).toString()),
        }));
    return { scheduler, service, createTask, deleteTask, cache, store, hooks, created };
}

const recurring = (schedule: string, extra: Record<string, unknown> = {}) => ({
    target: 'https://example.com/hook',
    queue: 'jobs',
    schedule: { type: 'recurring', schedule },
    isOccurrence: true,
    ...extra,
});

describe('MetaService', () => {
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

    describe('occurrence propagation', () => {
        it('the recurring occurrence relay carries the occurrence and the task id', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const { scheduler, service } = makeService();
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(
                UFID,
                recurring('0 * * * *', { headers: { A: 'b' }, occurrence: T }) as any,
                deliveryOf(T),
            );

            const relayReq = scheduler.createRelayEndpointTask.mock.calls[0][0];
            expect(relayReq.headers).toEqual({
                A: 'b',
                'X-Notitia-Task-ID': UFID,
                'X-Notitia-Occurrence': T,
            });
        });

        it('the long one-off final hop relay carries the occurrence and ends the chain', async () => {
            const at = '2026-12-20T09:00:00.000Z';
            jest.useFakeTimers({ now: new Date('2026-12-20T09:00:02Z') });
            const { scheduler, service } = makeService();

            await service.processMetaJob(
                UFID,
                { target: 'https://example.com/hook', schedule: { type: 'on', time: at }, isOccurrence: true, occurrence: at } as any,
                deliveryOf(at),
            );

            const [relayReq, scheduleTime, name] = scheduler.createRelayEndpointTask.mock.calls[0];
            expect(scheduleTime).toBeUndefined();
            expect(name).toBe(relayName(at));
            expect(relayReq.headers).toMatchObject({
                'X-Notitia-Task-ID': UFID,
                'X-Notitia-Occurrence': at,
            });
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID);
        });

        it('a re-scheduled meta payload carries the occurrence of the next hop', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const { scheduler, service } = makeService();
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            const [ufid, metaPayload, when] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(ufid).toBe(UFID);
            expect(metaPayload.occurrence).toBe('2026-11-16T11:00:00.000Z');
            expect(metaPayload.isOccurrence).toBe(true);
            expect(when).toEqual(new Date('2026-11-16T11:00:00Z'));
        });
    });

    describe('fork-free chain', () => {
        it('relays the occurrence and schedules the next one by name', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const { scheduler, service } = makeService();
            const T = '2026-11-16T10:00:00.000Z';
            const next = '2026-11-16T11:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            const [relayReq, relayAt, relayTaskName] = scheduler.createRelayEndpointTask.mock.calls[0];
            expect(relayTaskName).toBe(relayName(T));
            expect(relayAt).toBeUndefined();
            expect(relayReq.headers['X-Notitia-Occurrence']).toBe(T);

            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
            const [, , metaAt, metaTaskName] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(metaTaskName).toBe(metaName(next));
            expect(metaAt).toEqual(new Date(next));
            expect(scheduler.setIdForUfid).toHaveBeenCalledWith(UFID, metaName(next), 'jobs');
        });

        it('a replayed delivery creates the same names', async () => {
            const { service, createTask } = makeWorld();
            const T ='2026-11-16T10:00:00.000Z';
            const payload = recurring('0 * * * *', { occurrence: T }) as any;

            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            await service.processMetaJob(UFID, payload, deliveryOf(T));
            jest.setSystemTime(new Date('2026-11-16T10:00:40Z'));
            await service.processMetaJob(UFID, payload, deliveryOf(T));

            const names = createTask.mock.calls.map(([{ task }]: any) => task.name.split('/').at(-1));
            expect(names).toEqual([relayName(T), metaName('2026-11-16T11:00:00.000Z'), relayName(T), metaName('2026-11-16T11:00:00.000Z')]);
            await expect(createTask.mock.results[2].value).rejects.toMatchObject({ code: 6 });
            await expect(createTask.mock.results[3].value).rejects.toMatchObject({ code: 6 });
        });

        it('a late retry converges on the next shared occurrence', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:12:00Z') });
            const { scheduler, service } = makeService();
            const a = '2026-11-16T10:00:00.000Z';
            // The fork an earlier attempt of `a` at 10:03Z would have created.
            const b = '2026-11-16T10:05:00.000Z';

            await service.processMetaJob(UFID, recurring('*/5 * * * *', { occurrence: a }) as any, deliveryOf(a));
            await service.processMetaJob(UFID, recurring('*/5 * * * *', { occurrence: b }) as any, deliveryOf(b));

            const relayNames = scheduler.createRelayEndpointTask.mock.calls.map((c: any[]) => c[2]);
            expect(relayNames).toEqual([relayName(a), relayName(b)]);

            const metaCalls = scheduler.createMetaEndpointTask.mock.calls;
            expect(metaCalls).toHaveLength(2);
            expect(metaCalls[0][3]).toBe(metaName('2026-11-16T10:15:00.000Z'));
            expect(metaCalls[1][3]).toBe(metaCalls[0][3]);
            expect(metaCalls[0][2]).toEqual(new Date('2026-11-16T10:15:00Z'));
            expect(metaCalls[1][2]).toEqual(metaCalls[0][2]);
        });

        it('a payload with occurrence relays without ever looking up the tracked id', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.getIdFromUfid.mockResolvedValue(null);
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.getIdFromUfid).not.toHaveBeenCalled();
            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['missing', undefined],
            ['invalid', 'not-a-date'],
        ])('a payload whose occurrence is %s is dropped without relaying', async (_label, occurrence) => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const { scheduler, service } = makeService();

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence }) as any, { taskName: 'some-task', etaSeconds: 1763287200 });

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.setIdForUfid).not.toHaveBeenCalled();
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID);
        });

        it('a successor not after its occurrence is recomputed from now', async () => {
            const T = '2026-11-16T10:00:00.000Z';
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            // A rule evaluation that answers T itself for after(T).
            const helper = {
                calculateNextOccurrence: jest.fn((_schedule: string, from: Date) =>
                    from.getTime() === new Date(T).getTime() ? new Date(T) : new Date('2026-11-16T11:00:00Z'),
                ),
            };
            const service = new MetaService(scheduler as any, helper as any);
            const warn = jest.spyOn(Logger.prototype, 'warn');

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.createMetaEndpointTask.mock.calls[0][3]).toBe(metaName('2026-11-16T11:00:00.000Z'));
            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ ufid: UFID, occurrence: T }), 'meta-successor-not-after-occurrence');
        });

        it('the schedule time zone reaches the successor, across a DST change', async () => {
            const { scheduler, service } = makeService();
            const payloadFor = (occurrence: string) =>
                ({
                    target: 'https://example.com/hook',
                    queue: 'jobs',
                    schedule: { type: 'recurring', schedule: '0 21 * * *', timezone: 'Europe/Rome' },
                    isOccurrence: true,
                    occurrence,
                }) as any;

            // 21:00 CEST on Saturday; Rome leaves DST early on Sunday 2026-10-25.
            const T = '2026-10-24T19:00:00.000Z';
            jest.useFakeTimers({ now: new Date('2026-10-24T19:00:03Z') });
            await service.processMetaJob(UFID, payloadFor(T), deliveryOf(T));
            const S1 = '2026-10-25T20:00:00.000Z'; // 21:00 CET
            expect(scheduler.createMetaEndpointTask.mock.calls[0][3]).toBe(metaName(S1));
            expect(scheduler.createMetaEndpointTask.mock.calls[0][2]).toEqual(new Date(S1));

            jest.setSystemTime(new Date('2026-10-25T20:00:03Z'));
            await service.processMetaJob(UFID, payloadFor(S1), deliveryOf(S1));
            expect(scheduler.createMetaEndpointTask.mock.calls[1][3]).toBe(metaName('2026-10-26T20:00:00.000Z'));
        });

        it('ends the chain when the rule has no more occurrences', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const { scheduler, service } = makeService();
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(
                UFID,
                recurring('DTSTART:20261116T100000Z\nRRULE:FREQ=HOURLY;COUNT=1', { occurrence: T }) as any,
                deliveryOf(T),
            );

            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID);
            expect(scheduler.setIdForUfid).not.toHaveBeenCalled();
        });

        it('hops without relaying when the occurrence is beyond 30 days', async () => {
            const now = new Date('2026-11-16T10:00:00Z');
            jest.useFakeTimers({ now });
            const { scheduler, service } = makeService();
            const T = '2027-03-01T09:00:00.000Z';
            const delivery = { taskName: taskNameFor([UFID, 'create']), etaSeconds: now.getTime() / 1000 };

            await service.processMetaJob(
                UFID,
                { target: 'https://example.com/hook', schedule: { type: 'on', time: T }, isOccurrence: false, occurrence: T } as any,
                delivery,
            );

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
            const [, payload, at, name] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(name).toBe(taskNameFor([UFID, 'hop', T, delivery.taskName]));
            expect(at).toEqual(new Date(now.getTime() + 30 * DAY_MS));
            expect(payload.occurrence).toBe(T);
            expect(payload.isOccurrence).toBe(false);
        });

        it('a hop whose occurrence is now within 30 days schedules the final meta at the occurrence', async () => {
            const now = new Date('2026-11-16T10:00:00Z');
            jest.useFakeTimers({ now });
            const { scheduler, service } = makeService();
            const T = '2026-12-01T09:00:00.000Z';
            const delivery = { taskName: 'previous-hop', etaSeconds: now.getTime() / 1000 };

            await service.processMetaJob(
                UFID,
                { target: 'https://example.com/hook', schedule: { type: 'on', time: T }, isOccurrence: false, occurrence: T } as any,
                delivery,
            );

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            const [, payload, at, name] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(name).toBe(metaName(T));
            expect(at).toEqual(new Date(T));
            expect(payload.isOccurrence).toBe(true);
        });

        it('relays when its own ETA is the occurrence even if the clock is slightly behind', async () => {
            const T = '2026-11-16T10:00:00.000Z';
            jest.useFakeTimers({ now: new Date('2026-11-16T09:59:59.800Z') });
            const { scheduler, service } = makeService();

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.createRelayEndpointTask.mock.calls[0][2]).toBe(relayName(T));
            expect(scheduler.createMetaEndpointTask.mock.calls[0][3]).toBe(metaName('2026-11-16T11:00:00.000Z'));
        });

        it('a tracked-id write failure does not fail the delivery', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.setIdForUfid.mockRejectedValue(new Error('mongo down'));
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await expect(
                service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T)),
            ).resolves.toBeUndefined();

            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.setIdForUfid).toHaveBeenCalled();
        });

        it('a failed relay create fails the delivery so Cloud Tasks retries it', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.createRelayEndpointTask.mockRejectedValue(new Error('unavailable'));
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await expect(
                service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T)),
            ).rejects.toThrow('unavailable');
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
        });
    });

    describe('cancel by tombstone', () => {
        it('a tombstoned schedule relays nothing, schedules nothing and clears the tracked id', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.isTombstoned.mockResolvedValue(true);
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.isTombstoned).toHaveBeenCalledWith(UFID);
            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.setIdForUfid).not.toHaveBeenCalled();
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID);
        });

        it('a failed tombstone lookup does not stop the chain', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.isTombstoned.mockRejectedValue(new Error('mongo down'));
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
        });

        it('cancel without queue stops a jobs-queue schedule', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T09:30:00Z') });
            // The service default queue differs from the schedule's, so a queue-keyed lookup would miss.
            const { scheduler, service, deleteTask, store, created } = makeWorld('default');

            const ufid = await scheduler.scheduleJob({
                target: 'https://example.com/hook',
                queue: 'jobs',
                schedule: { type: 'recurring', schedule: '0 * * * *' },
            } as any);
            const [initial] = created();
            expect(initial.queue).toBe('meta-jobs');

            await expect(scheduler.cancelJob(ufid)).resolves.toBe(true);
            expect(store.has(`gcp_job:cancelled:${ufid}`)).toBe(true);
            expect(deleteTask.mock.calls[0][0]).toEqual({
                name: `projects/proj/locations/l/queues/meta-jobs/tasks/${taskNameFor([ufid, 'create'])}`,
            });

            // The first occurrence's delivery still arrives (the eager delete raced it).
            const T = initial.body.occurrence;
            expect(T).toBe('2026-11-16T10:00:00.000Z');
            jest.setSystemTime(new Date('2026-11-16T10:00:03Z'));
            await service.processMetaJob(ufid, initial.body, {
                taskName: initial.name,
                etaSeconds: new Date(T).getTime() / 1000,
            });

            expect(created()).toHaveLength(1);
            expect(store.has(`gcp_job:${ufid}`)).toBe(false);
        });

        it('cancel stops a schedule whose tracked-id write failed at create', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T09:30:00Z') });
            const { scheduler, service, cache, store, created } = makeWorld();
            cache.set.mockRejectedValueOnce(new Error('mongo down'));

            const ufid = await scheduler.scheduleJob({
                target: 'https://example.com/hook',
                queue: 'jobs',
                schedule: { type: 'recurring', schedule: '0 * * * *' },
            } as any);
            expect(store.has(`gcp_job:${ufid}`)).toBe(false);
            const [initial] = created();

            await expect(scheduler.cancelJob(ufid)).resolves.toBe(true);

            jest.setSystemTime(new Date('2026-11-16T10:00:03Z'));
            await service.processMetaJob(ufid, initial.body, {
                taskName: initial.name,
                etaSeconds: new Date(initial.body.occurrence).getTime() / 1000,
            });

            expect(created()).toHaveLength(1);
        });

        it('a cancel during a delivery stops the next occurrence', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T09:30:00Z') });
            const { scheduler, service, hooks, store, created } = makeWorld();

            const ufid = await scheduler.scheduleJob({
                target: 'https://example.com/hook',
                queue: 'jobs',
                schedule: { type: 'recurring', schedule: '0 * * * *' },
            } as any);
            const [initial] = created();
            const T = '2026-11-16T10:00:00.000Z';

            // The cancel lands while the delivery for T is relaying.
            let cancelled = false;
            hooks.onCreate = async (taskPath) => {
                if (!cancelled && taskPath.includes('/queues/jobs/')) {
                    cancelled = true;
                    await scheduler.cancelJob(ufid);
                }
            };

            jest.setSystemTime(new Date('2026-11-16T10:00:03Z'));
            await service.processMetaJob(ufid, initial.body, { taskName: initial.name, etaSeconds: new Date(T).getTime() / 1000 });

            // That delivery's relay goes out, and it still creates the meta task for S.
            const afterFirst = created();
            const relays = afterFirst.filter((t) => t.queue === 'jobs');
            expect(relays.map((t) => t.name)).toEqual([taskNameFor([ufid, 'relay', T])]);
            const S = '2026-11-16T11:00:00.000Z';
            const next = afterFirst.at(-1)!;
            expect(next.name).toBe(taskNameFor([ufid, 'meta', S]));

            // The delivery for S finds the tombstone: no relay, no further meta.
            jest.setSystemTime(new Date('2026-11-16T11:00:02Z'));
            await service.processMetaJob(ufid, next.body, { taskName: next.name, etaSeconds: new Date(S).getTime() / 1000 });

            expect(created()).toHaveLength(afterFirst.length);
            expect(store.has(`gcp_job:${ufid}`)).toBe(false);
        });
    });
});
