import { Logger } from '@nestjs/common';
import { CloudTasksClient } from '@google-cloud/tasks';
import { CloudTasksClientHolder, CLOUD_TASKS_KEEPALIVE_OPTIONS } from './cloud-tasks-client.holder';

jest.mock('@google-cloud/tasks', () => ({
    CloudTasksClient: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
}));

const UNAVAILABLE = 14;
const DEADLINE_EXCEEDED = 4;

function makeFactory() {
    const clients: any[] = [];
    const factory = jest.fn(() => {
        const client = { id: clients.length + 1, close: jest.fn().mockResolvedValue(undefined) };
        clients.push(client);
        return client as any;
    });
    return { clients, factory };
}

// Starts a call and lets fake timers drive backoff sleeps until it settles.
async function settle<T>(promise: Promise<T>) {
    const settled = promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
    );
    await jest.runAllTimersAsync();
    return settled as Promise<{ value?: T; error?: any }>;
}

describe('CloudTasksClientHolder', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('passes keepalive options to the client constructor', async () => {
        const holder = new CloudTasksClientHolder();
        await holder.get();
        expect(CloudTasksClient).toHaveBeenCalledWith(CLOUD_TASKS_KEEPALIVE_OPTIONS);
    });

    it('passes the per-attempt timeout to every call', async () => {
        const { factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory);
        const fn = jest.fn().mockResolvedValue('ok');
        await holder.call('op', fn);
        expect(fn).toHaveBeenCalledWith(expect.anything(), { timeout: 8000 });
    });

    it.each([
        ['UNAVAILABLE', UNAVAILABLE],
        ['DEADLINE_EXCEEDED', DEADLINE_EXCEEDED],
    ])('rebuilds the client and retries after %s', async (_name, code) => {
        const { clients, factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory);
        const fn = jest.fn().mockRejectedValueOnce({ code }).mockResolvedValueOnce('ok');

        const result = await settle(holder.call('op', fn));

        expect(result.value).toBe('ok');
        expect(factory).toHaveBeenCalledTimes(2);
        expect(clients[0].close).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[1][0]).toBe(clients[1]);
    });

    it('rebuilds once for concurrent failures', async () => {
        const { clients, factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory);
        const fn = jest.fn(async (client: any) => {
            if (client === clients[0]) throw { code: UNAVAILABLE };
            return 'ok';
        });

        const result = await settle(Promise.all([holder.call('a', fn), holder.call('b', fn), holder.call('c', fn)]));

        expect(result.value).toEqual(['ok', 'ok', 'ok']);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('gives up when the budget is spent and rethrows the last error', async () => {
        const { factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory, { totalBudgetMs: 25000 });
        const fn = jest.fn().mockRejectedValue({ code: UNAVAILABLE });
        const start = Date.now();

        const result = await settle(holder.call('op', fn));

        expect(result.error).toEqual({ code: UNAVAILABLE });
        expect(Date.now() - start).toBeLessThanOrEqual(25000);
        expect(fn.mock.calls.length).toBeGreaterThan(1);
    });

    it.each([6, 5])('does not retry gRPC code %i', async (code) => {
        const { factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory);
        const fn = jest.fn().mockRejectedValue({ code });

        const result = await settle(holder.call('op', fn));

        expect(result.error).toEqual({ code });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a bare INVALID_ARGUMENT without rebuilding', async () => {
        const { factory } = makeFactory();
        const holder = new CloudTasksClientHolder(factory);
        const fn = jest.fn().mockRejectedValueOnce({ code: 3, statusDetails: [] }).mockResolvedValueOnce('ok');

        const result = await settle(holder.call('op', fn));

        expect(result.value).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(factory).toHaveBeenCalledTimes(1);
    });
});
