import type { LoggerService } from '@nestjs/common';

export const ERROR_REPORTING_TYPE =
    'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

export function logAudit(
    logger: LoggerService,
    event: string,
    fields: Record<string, unknown>,
): void {
    logger.log({ ...fields, audit: true, event }, event);
}

export function logError(
    logger: LoggerService,
    err: unknown,
    fields: Record<string, unknown>,
): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack_trace = err instanceof Error ? err.stack : undefined;
    logger.error(
        {
            ...fields,
            '@type': ERROR_REPORTING_TYPE,
            message,
            ...(stack_trace ? { stack_trace } : {}),
        },
        message,
    );
}
