import { createHash } from 'crypto';

// Cloud Tasks names allow only [A-Za-z0-9_-] and up to 500 chars. A hex digest is always
// valid, and the NUL separator keeps ['a','b'] and ['ab'] distinct.
export function taskNameFor(parts: string[]): string {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}
