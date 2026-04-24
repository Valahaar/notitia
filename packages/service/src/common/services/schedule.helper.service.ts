import { Injectable, Logger } from '@nestjs/common';
import { RRule } from 'rrule';
import cronParser from 'cron-parser';
import { CronExpression } from 'cron-parser';

@Injectable()
export class ScheduleHelperService {
    private readonly logger = new Logger(ScheduleHelperService.name);

    /**
     * Calculates the next occurrence of a schedule from a given date.
     * Supports RRule (prefixed with "RRULE:") and CRON strings.
     * @param scheduleString The RRule or CRON string.
     * @param fromDate The date from which to calculate the next occurrence.
     * @param inclusive Whether the fromDate can be returned if it matches the schedule. For RRULE, 'after' is exclusive by default. For CRON, 'next' is exclusive.
     * @returns The Date of the next occurrence, or null if none is found or an error occurs.
     */
    public calculateNextOccurrence(scheduleString: string, fromDate: Date, inclusive: boolean = false): Date | null {
        this.logger.debug(
            { scheduleString, fromDate: fromDate.toISOString() },
            'Calculating next occurrence for schedule',
        );
        try {
            if (scheduleString.toUpperCase().includes('RRULE:')) {
                const rule = RRule.fromString(scheduleString);

                // RRule.after() is exclusive. If inclusive is true, we need to check if fromDate itself is a valid occurrence.
                // However, RRule.fromString doesn't preserve all original options like count or until if they were met.
                // The most straightforward way to handle inclusiveness with 'after' is to slightly adjust 'fromDate' if we need to include it.
                // But for simplicity and common use case of "what's strictly next", we'll rely on 'after'.
                // For more complex inclusive logic, one might need to get all occurrences in a range.

                // Ensure dtstart is set if not present, defaulting to fromDate for calculation start.
                // This ensures that 'after' behaves predictably relative to fromDate.
                const dtstart = rule.options.dtstart || fromDate;
                const effectiveRule = new RRule({
                    ...rule.origOptions,
                    dtstart: dtstart
                });

                // If inclusive is desired and fromDate itself is a valid occurrence,
                // we might need a different approach, e.g. by checking if effectiveRule.between(fromDate, fromDate, true).length > 0
                // For now, 'after' provides the next occurrence *after* the given date.
                // If 'inclusive' means "or equal to fromDate if fromDate is an occurrence", we can check it:
                if (inclusive) {
                    const occurrencesOnFromDate = effectiveRule.between(fromDate, fromDate, true);
                    if (occurrencesOnFromDate.length > 0) {
                        return fromDate;
                    }
                }
                return effectiveRule.after(fromDate, false); // false means not inclusive of fromDate for 'after'

            } else {
                const options = { currentDate: fromDate };
                const interval = cronParser.parse(scheduleString, options);

                // Note: Inclusive logic for CRON is complex and typically not needed for "next" occurrence.
                // cronParser.parse(..., { currentDate: fromDate }).next() correctly gives the next time *after* fromDate.
                return interval.next().toDate();
            }
        } catch (err: any) {
            this.logger.error(
                { scheduleString, error: err.message },
                'Error parsing schedule string',
            );
            return null;
        }
    }

    /**
     * Parses a schedule string (RRule or CRON) and returns an object
     * that can be used to get multiple occurrences or check specific dates.
     * This is a more advanced method if you need more than just the single next occurrence.
     * @param scheduleString The RRule or CRON string.
     * @returns RRule instance or cron-parser interval, or null on error.
     */
    public parseSchedule(scheduleString: string): RRule | CronExpression | null {
        try {
            if (scheduleString.toUpperCase().startsWith('RRULE:')) {
                const rruleString = scheduleString.substring(6);
                return RRule.fromString(rruleString);
            } else {
                return cronParser.parse(scheduleString);
            }
        } catch (err: any) {
            this.logger.error(
                { scheduleString, error: err.message },
                'Error parsing schedule string for advanced use',
            );
            return null;
        }
    }
}