import { Logger } from '@nestjs/common';
import { CloudTasksClient } from '@google-cloud/tasks';

// Keepalive pings detect a half-dead HTTP/2 channel (idle NAT/LB drop) instead of letting a
// call hang until its deadline. 60s is the floor: Google front ends GOAWAY ENHANCE_YOUR_CALM
// on more frequent pings.
export const CLOUD_TASKS_KEEPALIVE_OPTIONS = {
    'grpc.keepalive_time_ms': 60000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
};

const DEADLINE_EXCEEDED = 4;
const INVALID_ARGUMENT = 3;
const UNAVAILABLE = 14;

const INVALID_ARGUMENT_MAX_ATTEMPTS = 3;
const INVALID_ARGUMENT_RETRY_BASE_MS = 150;

// Cloud Tasks occasionally rejects a valid createTask call with a bare INVALID_ARGUMENT
// ("Request contains an invalid argument.") and no google.rpc.BadRequest field violations;
// the identical request succeeds moments later. A genuinely malformed task names the
// offending field, so only the bare form is retried.
export const isBareInvalidArgument = (error: any): boolean => {
    if (error?.code !== INVALID_ARGUMENT) return false;
    const violations = Array.isArray(error.statusDetails)
        ? error.statusDetails.flatMap((d: any) => d?.fieldViolations ?? [])
        : [];
    return violations.length === 0;
};

export interface CloudTasksClientHolderOptions {
    attemptTimeoutMs?: number;
    totalBudgetMs?: number;
    baseDelayMs?: number;
}

/**
 * Owns the CloudTasksClient: builds it lazily with keepalive, gives every call a short
 * per-attempt deadline, and on DEADLINE_EXCEEDED / UNAVAILABLE replaces the (probably dead)
 * channel once and retries within a total time budget.
 */
export class CloudTasksClientHolder {
    private readonly logger = new Logger(CloudTasksClientHolder.name);
    private current: Promise<CloudTasksClient> | null = null;
    private readonly attemptTimeoutMs: number;
    private readonly totalBudgetMs: number;
    private readonly baseDelayMs: number;

    constructor(
        private readonly factory: () => CloudTasksClient = () => new CloudTasksClient(CLOUD_TASKS_KEEPALIVE_OPTIONS),
        opts: CloudTasksClientHolderOptions = {},
    ) {
        this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 8000;
        this.totalBudgetMs = opts.totalBudgetMs ?? 25000;
        this.baseDelayMs = opts.baseDelayMs ?? 200;
    }

    // Held as a promise so construction (gRPC + proto descriptor loading, ~100s of ms) stays
    // off the Nest bootstrap chain and happens on first use.
    get(): Promise<CloudTasksClient> {
        if (!this.current) this.current = this.build();
        return this.current;
    }

    private build(): Promise<CloudTasksClient> {
        const built: Promise<CloudTasksClient> = Promise.resolve().then(() => this.factory());
        built.catch((err) => {
            this.logger.error({ err }, 'Failed to initialize CloudTasksClient');
            // Let the next get() try again instead of caching the failure forever.
            if (this.current === built) this.current = null;
        });
        return built;
    }

    // Single-flight: only the caller whose failed client is still current performs the swap;
    // concurrent failures on the same dead client just retry on the replacement.
    private rebuild(failed: Promise<CloudTasksClient>, op: string, code: number): void {
        if (this.current !== failed) return;
        this.current = this.build();
        this.logger.warn({ op, code }, 'cloud-tasks-client-rebuilt');
        failed
            .then((old) => old.close())
            .catch(() => {
                // closing a dead client may throw; irrelevant
            });
    }

    async call<T>(op: string, fn: (client: CloudTasksClient, callOptions: { timeout: number }) => Promise<T>): Promise<T> {
        const start = Date.now();
        for (let attempt = 1; ; attempt++) {
            const clientPromise = this.get();
            const client = await clientPromise;
            try {
                return await fn(client, { timeout: this.attemptTimeoutMs });
            } catch (error: any) {
                const code: number | undefined = error?.code;
                const channelFailure = code === DEADLINE_EXCEEDED || code === UNAVAILABLE;
                const bare = isBareInvalidArgument(error);
                if (!channelFailure && !bare) throw error;
                if (bare && attempt >= INVALID_ARGUMENT_MAX_ATTEMPTS) throw error;

                const base = bare ? INVALID_ARGUMENT_RETRY_BASE_MS : this.baseDelayMs;
                const delayMs = Math.round(base * 2 ** (attempt - 1) * (0.5 + Math.random()));
                if (Date.now() - start + delayMs + this.attemptTimeoutMs > this.totalBudgetMs) throw error;

                if (channelFailure) this.rebuild(clientPromise, op, code!);
                this.logger.warn({ op, attempt, code, delayMs }, 'Retrying Cloud Tasks call');
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
}
