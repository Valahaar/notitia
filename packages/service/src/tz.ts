// Imported first by main.ts: recurring-schedule math (rrule) depends on the process time zone,
// and every schedule without an explicit `timezone` is defined as UTC. Node applies a
// process.env.TZ assignment immediately, so this overrides any TZ the environment sets.
process.env.TZ = 'UTC';

export {};
