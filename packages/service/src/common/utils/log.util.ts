/**
 * Strips the query string from a URL for safe logging.
 * Query params may contain API keys or tokens.
 */
export function safeUrl(url: string): string {
    const idx = url.indexOf('?');
    return idx === -1 ? url : `${url.slice(0, idx)}?[REDACTED]`;
}
