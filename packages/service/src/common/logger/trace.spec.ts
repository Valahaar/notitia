import { parseCloudTrace } from './trace';

describe('parseCloudTrace', () => {
    it('returns empty object when header is missing', () => {
        expect(parseCloudTrace(undefined, 'my-proj')).toEqual({});
        expect(parseCloudTrace('', 'my-proj')).toEqual({});
    });

    it('parses trace/span/sampled with ;o=1', () => {
        const result = parseCloudTrace('abc123/456;o=1', 'my-proj');
        expect(result).toEqual({
            'logging.googleapis.com/trace': 'projects/my-proj/traces/abc123',
            'logging.googleapis.com/spanId': '456',
            'logging.googleapis.com/trace_sampled': true,
        });
    });

    it('parses ;o=0 as not sampled', () => {
        const result = parseCloudTrace('abc123/456;o=0', 'my-proj');
        expect(result['logging.googleapis.com/trace_sampled']).toBe(false);
    });

    it('omits spanId when span segment is absent', () => {
        const result = parseCloudTrace('abc123', 'my-proj');
        expect(result['logging.googleapis.com/trace']).toBe('projects/my-proj/traces/abc123');
        expect(result['logging.googleapis.com/spanId']).toBeUndefined();
    });

    it('emits bare trace (no project qualifier) when projectId absent', () => {
        const result = parseCloudTrace('abc123/456;o=1', undefined);
        expect(result['logging.googleapis.com/trace']).toBe('abc123');
    });

    it('returns empty object on malformed header', () => {
        expect(parseCloudTrace('///;;;', 'my-proj')).toEqual({});
    });
});
