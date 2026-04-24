type LogArgs = unknown[];
type LogMethod = (this: unknown, ...args: LogArgs) => void;

// numeric level thresholds (pino defaults): warn=40, so anything < 40 is info/debug/trace
const WARN_LEVEL = 40;

export function makeSampler(sampleRate: number, rng: () => number = Math.random) {
    return function logMethod(this: unknown, args: LogArgs, method: LogMethod, level: number) {
        if (level >= WARN_LEVEL) {
            method.apply(this, args);
            return;
        }
        const first = args[0];
        if (first && typeof first === 'object') {
            const bindings = first as Record<string, unknown>;
            if (bindings.audit === true) {
                method.apply(this, args);
                return;
            }
            if (bindings.sampleable === true && rng() >= sampleRate) {
                return; // drop
            }
        }
        method.apply(this, args);
    };
}
