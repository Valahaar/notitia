import { Logger } from '@nestjs/common';
import { MetaService } from './meta.service';
import { GcpTaskSchedulerService } from './gcp-task.scheduler.service';

const UFID = '1234567890123456789';

function makeScheduler(next: Record<string, unknown>) {
    return {
        getQueueName: jest.fn().mockReturnValue('jobs'),
        getIdFromUfid: jest.fn().mockResolvedValue('tracked-task'),
        setIdForUfid: jest.fn().mockResolvedValue(undefined),
        delUfid: jest.fn().mockResolvedValue(undefined),
        computeNextExecutionTime: jest.fn().mockReturnValue(next),
        createRelayEndpointTask: jest.fn().mockResolvedValue('relay-id'),
        createMetaEndpointTask: jest.fn().mockResolvedValue('meta-id'),
        withOccurrenceHeader: GcpTaskSchedulerService.prototype.withOccurrenceHeader,
    };
}

describe('MetaService occurrence propagation', () => {
    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
    });

    afterEach(() => jest.restoreAllMocks());

    it('the recurring occurrence relay carries the occurrence and the task id', async () => {
        const nextAt = new Date('2026-11-16T11:00:00Z');
        const scheduler = makeScheduler({
            nextExecutionTime: nextAt,
            realNextExecutionTime: nextAt,
            recurring: true,
            nextIsOccurrence: true,
        });
        const service = new MetaService(scheduler as any);

        await service.processMetaJob(UFID, {
            target: 'https://example.com/hook',
            headers: { A: 'b' },
            schedule: { type: 'recurring', schedule: '0 * * * *' },
            isOccurrence: true,
            occurrence: '2026-11-16T10:00:00.000Z',
        } as any);

        const relayReq = scheduler.createRelayEndpointTask.mock.calls[0][0];
        expect(relayReq.headers).toEqual({
            A: 'b',
            'X-Notitia-Task-ID': UFID,
            'X-Notitia-Occurrence': '2026-11-16T10:00:00.000Z',
        });
    });

    it('the long one-off final hop relay carries the occurrence', async () => {
        const at = new Date('2026-12-20T09:00:00Z');
        const scheduler = makeScheduler({
            nextExecutionTime: at,
            realNextExecutionTime: at,
            recurring: false,
            nextIsOccurrence: true,
        });
        const service = new MetaService(scheduler as any);

        await service.processMetaJob(UFID, {
            target: 'https://example.com/hook',
            schedule: { type: 'on', time: at.toISOString() },
            isOccurrence: true,
            occurrence: at.toISOString(),
        } as any);

        const [relayReq, scheduleTime] = scheduler.createRelayEndpointTask.mock.calls[0];
        expect(scheduleTime).toBe(at);
        expect(relayReq.headers).toMatchObject({
            'X-Notitia-Task-ID': UFID,
            'X-Notitia-Occurrence': '2026-12-20T09:00:00.000Z',
        });
    });

    it('a re-scheduled meta payload carries the occurrence of the next hop', async () => {
        const nextAt = new Date('2026-11-16T11:00:00Z');
        const scheduler = makeScheduler({
            nextExecutionTime: nextAt,
            realNextExecutionTime: nextAt,
            recurring: true,
            nextIsOccurrence: true,
        });
        const service = new MetaService(scheduler as any);

        await service.processMetaJob(UFID, {
            target: 'https://example.com/hook',
            schedule: { type: 'recurring', schedule: '0 * * * *' },
            isOccurrence: true,
            occurrence: '2026-11-16T10:00:00.000Z',
        } as any);

        const [ufid, metaPayload, when] = scheduler.createMetaEndpointTask.mock.calls[0];
        expect(ufid).toBe(UFID);
        expect(metaPayload.occurrence).toBe('2026-11-16T11:00:00.000Z');
        expect(metaPayload.isOccurrence).toBe(true);
        expect(when).toBe(nextAt);
    });
});
