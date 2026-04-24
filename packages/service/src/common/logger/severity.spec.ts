import { levelToSeverity } from './severity';

describe('levelToSeverity', () => {
    it.each([
        ['trace', 'DEBUG'],
        ['debug', 'DEBUG'],
        ['info', 'INFO'],
        ['warn', 'WARNING'],
        ['error', 'ERROR'],
        ['fatal', 'CRITICAL'],
    ])('maps pino %s to GCP %s', (label, expected) => {
        expect(levelToSeverity(label)).toBe(expected);
    });

    it('falls back to DEFAULT for unknown levels', () => {
        expect(levelToSeverity('unknown')).toBe('DEFAULT');
    });
});
