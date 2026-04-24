import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { v4 as uuidv4 } from 'uuid';
import { readLoggerEnv } from './config';
import { buildRedactPaths } from './redact';
import { levelToSeverity } from './severity';
import { makeSampler } from './sampler';
import { parseCloudTrace } from './trace';

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
                        customProps: (req: any) => {
                            // pino-http's middleware runs before AppModule.configure() middleware,
                            // so RequestIdMiddleware hasn't set the header yet when this fires.
                            // Generate the ID here so logs are correlated; write it back so
                            // RequestIdMiddleware reuses the same value on the response header.
                            let requestId = req.headers['x-request-id'] as string | undefined;
                            if (!requestId) {
                                requestId = uuidv4();
                                req.headers['x-request-id'] = requestId;
                            }
                            return {
                                requestId,
                                // Parse the Cloud Trace header directly here rather than relying on
                                // TraceContextMiddleware, because pino-http fires before NestJS
                                // module-registered middleware runs.
                                ...parseCloudTrace(
                                    req.headers['x-cloud-trace-context'] as string | undefined,
                                    process.env.GCP_PROJECT_ID,
                                ),
                            };
                        },
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
