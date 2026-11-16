import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
    public calculateNextOccurrence(
        scheduleString: string,
        fromDate: Date,
        options: { inclusive?: boolean; timezone?: string } = {},
    ): Date | null {
        const inclusive = options.inclusive ?? false;
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
                // Normalized rules always carry a DTSTART (with TZID, handled by rrule itself). The
                // fromDate fallback is only for un-normalized rules from pre-N2 meta payloads.
                const effectiveRule = rule.origOptions.dtstart
                    ? rule
                    : new RRule({ ...rule.origOptions, dtstart: fromDate });

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
                const interval = cronParser.parse(scheduleString, {
                    currentDate: fromDate,
                    tz: options.timezone ?? 'UTC',
                });

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
     * Anchors a recurring schedule once, at creation. Cron is returned unchanged. An RRULE without
     * DTSTART gets `DTSTART;TZID=<timezone ?? UTC>:<now in that zone>` so occurrences stay stable.
     * An RRULE whose DTSTART TZID differs from `timezone` is rejected.
     */
    public normalizeRecurringSchedule(scheduleString: string, timezone: string | undefined, now: Date): string {
        if (!scheduleString.toUpperCase().includes('RRULE:')) {
            return scheduleString;
        }
        const dtstartMatch = /DTSTART(?:;TZID=([^:;\r\n]+))?/i.exec(scheduleString);
        if (dtstartMatch) {
            const tzid = dtstartMatch[1];
            if (tzid && timezone && tzid !== timezone) {
                throw new BadRequestException(`schedule DTSTART time zone ${tzid} differs from timezone ${timezone}`);
            }
            return scheduleString;
        }
        const zone = timezone ?? 'UTC';
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(now);
        const get = (type: string) => parts.find((p) => p.type === type)!.value;
        const local = `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
        return `DTSTART;TZID=${zone}:${local}\n${scheduleString}`;
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