export const DEFAULT_REDACT_PATHS: string[] = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-goog-*"]',
    '*.password',
    '*.token',
    '*.secret',
    '*.apiKey',
    '*.api_key',
];

export function buildRedactPaths(userList: string | undefined): string[] {
    const extras = (userList ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return [...DEFAULT_REDACT_PATHS, ...extras];
}
