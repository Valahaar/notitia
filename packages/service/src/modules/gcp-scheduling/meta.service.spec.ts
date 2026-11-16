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
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID, undefined);
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
            // Real scheduler over a fake Cloud Tasks that refuses a known name with ALREADY_EXISTS.
            const existing = new Set<string>();
            const createTask = jest.fn().mockImplementation(async ({ task }: any) => {
                const short = task.name.split('/').at(-1);
                if (existing.has(short)) {
                    throw { code: 6, details: 'Requested entity already exists' };
                }
                existing.add(short);
                return [{ name: task.name }];
            });
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
            const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
            const scheduler = new GcpTaskSchedulerService(config as any, new ScheduleHelperService(), cache as any);
            (scheduler as any).clientHolder = new CloudTasksClientHolder(() => ({
                queuePath: (_p: string, _l: string, q: string) => `projects/proj/locations/l/queues/${q}`,
                taskPath: (_p: string, _l: string, q: string, t: string) => `projects/proj/locations/l/queues/${q}/tasks/${t}`,
                createTask,
                close: jest.fn(),
            }) as any);
            const service = new MetaService(scheduler, new ScheduleHelperService());
            const T = '2026-11-16T10:00:00.000Z';
            const payload = recurring('0 * * * *', { occurrence: T }) as any;

            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            await service.processMetaJob(UFID, payload, deliveryOf(T));
            jest.setSystemTime(new Date('2026-11-16T10:00:40Z'));
            await service.processMetaJob(UFID, payload, deliveryOf(T));

            const names = createTask.mock.calls.map(([{ task }]: any) => task.name.split('/').at(-1));
            expect(names).toEqual([relayName(T), metaName('2026-11-16T11:00:00.000Z'), relayName(T), metaName('2026-11-16T11:00:00.000Z')]);
            expect(existing.size).toBe(2);
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

        it('does not stop when the tracked id is missing', async () => {
            jest.useFakeTimers({ now: new Date('2026-11-16T10:00:05Z') });
            const scheduler = makeScheduler();
            scheduler.getIdFromUfid.mockResolvedValue(null);
            const { service } = makeService(scheduler);
            const T = '2026-11-16T10:00:00.000Z';

            await service.processMetaJob(UFID, recurring('0 * * * *', { occurrence: T }) as any, deliveryOf(T));

            expect(scheduler.createRelayEndpointTask).toHaveBeenCalledTimes(1);
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
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
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID, 'jobs');
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

        it('takes the occurrence from the task ETA for a v1.3.4 payload', async () => {
            jest.useFakeTimers({ now: new Date('2025-11-16T10:00:03Z') });
            const { scheduler, service } = makeService();

            await service.processMetaJob(
                UFID,
                recurring('0 * * * *') as any,
                { taskName: 'legacy-numeric-task', etaSeconds: 1763287200 },
            );

            const [relayReq, , name] = scheduler.createRelayEndpointTask.mock.calls[0];
            expect(relayReq.headers['X-Notitia-Occurrence']).toBe('2025-11-16T10:00:00.000Z');
            expect(name).toBe(relayName('2025-11-16T10:00:00.000Z'));
            expect(scheduler.createMetaEndpointTask.mock.calls[0][3]).toBe(metaName('2025-11-16T11:00:00.000Z'));
        });

        it('a v1.3.4 one-off hop takes T from schedule.time, not from its ETA', async () => {
            const now = new Date('2026-11-16T10:00:00Z');
            jest.useFakeTimers({ now });
            const { scheduler, service } = makeService();
            const time = '2026-12-01T09:00:00.000Z';

            // v1.3.4 shape: no occurrence; the hop fired at its 30-day horizon (ETA = now).
            await service.processMetaJob(
                UFID,
                { target: 'https://example.com/hook', queue: 'jobs', schedule: { type: 'on', time }, isOccurrence: false } as any,
                { taskName: 'legacy-numeric-task', etaSeconds: now.getTime() / 1000 },
            );

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
            const [, payload, at, name] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(name).toBe(metaName(time));
            expect(at).toEqual(new Date(time));
            expect(payload.occurrence).toBe(time);
            expect(payload.isOccurrence).toBe(true);
            expect(scheduler.setIdForUfid).toHaveBeenCalledWith(UFID, metaName(time), 'jobs');
        });

        it('a v1.3.4 recurring hop takes T as the next occurrence after now, not its ETA', async () => {
            const now = new Date('2026-11-16T10:00:00Z');
            jest.useFakeTimers({ now });
            const { scheduler, service } = makeService();
            const next = '2026-12-01T09:00:00.000Z';

            await service.processMetaJob(
                UFID,
                recurring('0 9 1 12 *', { isOccurrence: false }) as any,
                { taskName: 'legacy-numeric-task', etaSeconds: now.getTime() / 1000 },
            );

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).toHaveBeenCalledTimes(1);
            const [, payload, at, name] = scheduler.createMetaEndpointTask.mock.calls[0];
            expect(name).toBe(metaName(next));
            expect(at).toEqual(new Date(next));
            expect(payload.occurrence).toBe(next);
            expect(payload.isOccurrence).toBe(true);
            expect(scheduler.setIdForUfid).toHaveBeenCalledWith(UFID, metaName(next), 'jobs');
        });

        it('a v1.3.4 recurring hop whose rule has no next occurrence ends the chain', async () => {
            const now = new Date('2026-11-16T10:00:00Z');
            jest.useFakeTimers({ now });
            const { scheduler, service } = makeService();

            await service.processMetaJob(
                UFID,
                recurring('DTSTART:20250101T090000Z\nRRULE:FREQ=YEARLY;COUNT=1', { isOccurrence: false }) as any,
                { taskName: 'legacy-numeric-task', etaSeconds: now.getTime() / 1000 },
            );

            expect(scheduler.createRelayEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.createMetaEndpointTask).not.toHaveBeenCalled();
            expect(scheduler.setIdForUfid).not.toHaveBeenCalled();
            expect(scheduler.delUfid).toHaveBeenCalledWith(UFID, 'jobs');
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
});
