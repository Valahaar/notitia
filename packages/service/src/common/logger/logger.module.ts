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
