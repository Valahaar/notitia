import { buildRedactPaths, DEFAULT_REDACT_PATHS } from './redact';

describe('buildRedactPaths', () => {
    it('returns the default paths when no user list provided', () => {
        expect(buildRedactPaths('')).toEqual(DEFAULT_REDACT_PATHS);
        expect(buildRedactPaths(undefined)).toEqual(DEFAULT_REDACT_PATHS);
    });

    it('appends comma-separated user paths after defaults', () => {
        const result = buildRedactPaths('foo.bar, baz.qux');
        expect(result).toEqual([...DEFAULT_REDACT_PATHS, 'foo.bar', 'baz.qux']);
    });

    it('ignores empty entries from trailing/duplicate commas', () => {
        const result = buildRedactPaths('foo.bar,,,baz.qux,');
        expect(result).toEqual([...DEFAULT_REDACT_PATHS, 'foo.bar', 'baz.qux']);
    });

    it('defaults cover authorization, cookie, password, token, secret', () => {
        expect(DEFAULT_REDACT_PATHS).toEqual(
            expect.arrayContaining([
                'req.headers.authorization',
                'req.headers.cookie',
                '*.password',
                '*.token',
                '*.secret',
            ]),
        );
    });
});
