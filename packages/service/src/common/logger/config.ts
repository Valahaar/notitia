export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFormat = 'json' | 'pretty';

export interface LoggerConfig {
    level: LogLevel;
    format: LogFormat;
    sampleRate: number;
    includeSource: boolean;
    redactEnv: string;
    projectId: string | undefined;
}

const VALID_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const VALID_FORMATS: readonly LogFormat[] = ['json', 'pretty'];

export function readLoggerEnv(env: Record<string, string | undefined>): LoggerConfig {
    const isProd = env.NODE_ENV === 'production';

    const level = (env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')) as LogLevel;
    if (!VALID_LEVELS.includes(level)) {
        throw new Error(`LOG_LEVEL must be one of ${VALID_LEVELS.join('|')} (got "${env.LOG_LEVEL}")`);
    }

    const format = (env.LOG_FORMAT ?? (isProd ? 'json' : 'pretty')) as LogFormat;
    if (!VALID_FORMATS.includes(format)) {
        throw new Error(`LOG_FORMAT must be "json" or "pretty" (got "${env.LOG_FORMAT}")`);
    }

    const rateRaw = env.LOG_SAMPLE_RATE;
    const sampleRate = rateRaw === undefined ? 1.0 : Number(rateRaw);
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        throw new Error(`LOG_SAMPLE_RATE must be a number in [0, 1] (got "${rateRaw}")`);
    }

    const includeSourceRaw = env.LOG_INCLUDE_SOURCE;
    let includeSource: boolean;
    if (includeSourceRaw === undefined) {
        includeSource = level === 'debug' || level === 'trace';
    } else if (includeSourceRaw === 'true') {
        includeSource = true;
    } else if (includeSourceRaw === 'false') {
        includeSource = false;
    } else {
        throw new Error(`LOG_INCLUDE_SOURCE must be "true" or "false" (got "${includeSourceRaw}")`);
    }

    return {
        level,
        format,
        sampleRate,
        includeSource,
        redactEnv: env.LOG_REDACT ?? '',
        projectId: env.GCP_PROJECT_ID,
    };
}
