import { Logger } from '@nestjs/common';
import { InMemorySchedulerService } from './in-memory.scheduler.service';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';

describe('InMemorySchedulerService occurrence headers', () => {
    let executor: { executeHttpRequest: jest.Mock };
    let service: InMemorySchedulerService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'debug').mockImplementation();
        executor = { executeHttpRequest: jest.fn().mockResolvedValue({ success: true, status: 200 }) };
        service = new InMemorySchedulerService(new ScheduleHelperService(), executor as any);
    });

    afterEach(() => {
        service.onModuleDestroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('recurring fires carry task id and occurrence headers', async () => {
        jest.setSystemTime(new Date('2026-11-16T10:02:00Z'));
        const jobId = await service.scheduleJob({
            target: 'https://example.com/hook',
            headers: { A: 'b' },
            schedule: { type: 'recurring', schedule: '*/5 * * * *' },
        } as any);

        await jest.advanceTimersByTimeAsync(3 * 60 * 1000);

        expect(executor.executeHttpRequest).toHaveBeenCalledTimes(1);
        const arg = executor.executeHttpRequest.mock.calls[0][0];
        expect(arg.taskId).toBe(jobId);
        expect(arg.headers).toEqual({
            A: 'b',
            'X-Notitia-Task-ID': jobId,
            'X-Notitia-Occurrence': '2026-11-16T10:05:00.000Z',
        });
    });

    it('in-memory recurring honours timezone', async () => {
        jest.setSystemTime(new Date('2026-11-16T10:00:00Z'));
        await service.scheduleJob({
            target: 'https://example.com/hook',
            schedule: { type: 'recurring', schedule: '0 21 * * *', timezone: 'Europe/Rome' },
        } as any);

        await jest.advanceTimersByTimeAsync(9 * 60 * 60 * 1000 + 1000);
        expect(executor.executeHttpRequest).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(executor.executeHttpRequest).toHaveBeenCalledTimes(1);
        expect(executor.executeHttpRequest.mock.calls[0][0].headers['X-Notitia-Occurrence']).toBe(
            '2026-11-16T20:00:00.000Z',
        );
    });

    it('a scheduled one-off carries the occurrence, an immediate one does not', async () => {
        jest.setSystemTime(new Date('2026-11-16T10:00:00Z'));
        await service.scheduleJob({
            target: 'https://example.com/hook',
            schedule: { type: 'on', time: '2026-11-16T10:01:00Z' },
        } as any);
        await service.scheduleJob({ target: 'https://example.com/hook' } as any);

        expect(executor.executeHttpRequest).toHaveBeenCalledTimes(1);
        expect(executor.executeHttpRequest.mock.calls[0][0].headers?.['X-Notitia-Occurrence']).toBeUndefined();

        await jest.advanceTimersByTimeAsync(61 * 1000);
        expect(executor.executeHttpRequest.mock.calls[1][0].headers['X-Notitia-Occurrence']).toBe(
            '2026-11-16T10:01:00.000Z',
        );
    });
});
