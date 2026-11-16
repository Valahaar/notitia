import { taskNameFor } from './task-name';

describe('taskNameFor', () => {
    it('is deterministic', () => {
        expect(taskNameFor(['key', 'jobs', 'k'])).toBe(taskNameFor(['key', 'jobs', 'k']));
    });

    it('differs per part', () => {
        expect(taskNameFor(['a', 'b'])).not.toBe(taskNameFor(['ab']));
    });

    it('uses only allowed characters and is 40 long', () => {
        expect(taskNameFor(['req', 'anything/with spaces'])).toMatch(/^[0-9a-f]{40}$/);
    });
});
