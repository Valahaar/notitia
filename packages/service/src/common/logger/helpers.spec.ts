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

describe('reserved-key protection', () => {
    it('logAudit: caller-supplied audit/event cannot override reserved values', () => {
        const logger = makeLogger();
        logAudit(logger as any, 'job.scheduled', { audit: false, event: 'spoofed' } as any);
        const payload = logger.captured[0].args[0] as Record<string, unknown>;
        expect(payload.audit).toBe(true);
        expect(payload.event).toBe('job.scheduled');
    });

    it('logError: caller-supplied @type/message/stack_trace cannot override reserved values', () => {
        const logger = makeLogger();
        logError(logger as any, new Error('real'), {
            '@type': 'wrong',
            message: 'wrong',
            stack_trace: 'wrong',
        });
        const payload = logger.captured[0].args[0] as Record<string, unknown>;
        expect(payload['@type']).toBe(ERROR_REPORTING_TYPE);
        expect(payload.message).toBe('real');
        expect(typeof payload.stack_trace).toBe('string');
        expect(payload.stack_trace).toContain('Error: real');
    });
});
