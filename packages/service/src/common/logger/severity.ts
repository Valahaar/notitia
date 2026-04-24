const MAP: Record<string, string> = {
    trace: 'DEBUG',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARNING',
    error: 'ERROR',
    fatal: 'CRITICAL',
};

export function levelToSeverity(label: string): string {
    return MAP[label] ?? 'DEFAULT';
}
