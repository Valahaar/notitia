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
