// Recurring-schedule math (rrule) depends on the process time zone, and prod runs in UTC
// (src/tz.ts pins it there). Pin the tests too, whatever TZ the shell exports: Node applies a
// process.env.TZ assignment immediately, and jest workers inherit it.
module.exports = async () => {
    process.env.TZ = 'UTC';
};
