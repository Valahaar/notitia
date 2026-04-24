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
                                      const lines = (err.stack ?? '').split('\n').slice(1); // drop "Error"
                                      const skipPatterns = ['/pino/', '/pino-http/', '/nestjs-pino/', '/logger.module.', '/sampler.'];
                                      const frameRe = /at\s+(\S+)\s+\(([^:]+):(\d+):\d+\)/;
                                      for (const line of lines) {
                                          const match = frameRe.exec(line);
                                          if (!match) continue;
                                          const [, fn, file, lineNo] = match;
                                          if (skipPatterns.some((p) => file.includes(p))) continue;
                                          return {
                                              'logging.googleapis.com/sourceLocation': {
                                                  function: fn,
                                                  file,
                                                  line: lineNo,
                                              },
                                          };
                                      }
                                      return {};
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
