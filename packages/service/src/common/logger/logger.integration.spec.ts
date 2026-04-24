import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, Controller, Get } from '@nestjs/common';
import { Logger as PinoLogger, LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import * as request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
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
                customProps: (req: any) => {
                    let requestId = req.headers['x-request-id'] as string | undefined;
                    if (!requestId) {
                        requestId = uuidv4();
                        req.headers['x-request-id'] = requestId;
                    }
                    return {
                        requestId,
                        ...parseCloudTrace(
                            req.headers['x-cloud-trace-context'] as string | undefined,
                            process.env.GCP_PROJECT_ID,
                        ),
                    };
                },
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

    it('generates a requestId when the client does not send X-Request-ID', async () => {
        const response = await request(app.getHttpServer()).get('/ping').expect(200);
        const returnedId = response.headers['x-request-id'];
        expect(typeof returnedId).toBe('string');
        expect(returnedId.length).toBeGreaterThan(10);
        // Verify the generated ID looks like a UUID (8-4-4-4-12 hex digits pattern)
        expect(returnedId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    });
});
