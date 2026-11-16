import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { ScheduleHelperService } from './schedule.helper.service';
import { RecurringScheduleDto } from '../dto/schedule-request.dto';

describe('ScheduleHelperService', () => {
    const helper = new ScheduleHelperService();

    it('cron keeps local time across DST', () => {
        const opts = { timezone: 'Europe/Rome' };
        expect(helper.calculateNextOccurrence('0 21 * * *', new Date('2026-10-24T12:00:00Z'), opts)?.toISOString()).toBe(
            '2026-10-24T19:00:00.000Z',
        );
        expect(helper.calculateNextOccurrence('0 21 * * *', new Date('2026-10-26T12:00:00Z'), opts)?.toISOString()).toBe(
            '2026-10-26T20:00:00.000Z',
        );
    });

    it('cron without a timezone is UTC', () => {
        expect(helper.calculateNextOccurrence('0 21 * * *', new Date('2026-10-24T12:00:00Z'))?.toISOString()).toBe(
            '2026-10-24T21:00:00.000Z',
        );
    });

    it('rrule with a TZID dtstart keeps local time across DST', () => {
        const rule = 'DTSTART;TZID=Europe/Rome:20261020T210000\nRRULE:FREQ=DAILY';
        expect(helper.calculateNextOccurrence(rule, new Date('2026-10-26T12:00:00Z'))?.toISOString()).toBe(
            '2026-10-26T20:00:00.000Z',
        );
    });

    it('anchors an rrule without dtstart once', () => {
        const normalized = helper.normalizeRecurringSchedule(
            'RRULE:FREQ=HOURLY;INTERVAL=6',
            'Europe/Rome',
            new Date('2026-11-16T10:15:42.500Z'),
        );
        expect(normalized).toContain('DTSTART;TZID=Europe/Rome:20261116T111542');
        expect(helper.calculateNextOccurrence(normalized, new Date('2026-11-16T12:00:00Z'))?.toISOString()).toBe(
            '2026-11-16T16:15:42.000Z',
        );
    });

    it('rejects a dtstart time zone that differs from timezone', () => {
        expect(() =>
            helper.normalizeRecurringSchedule(
                'DTSTART;TZID=Europe/Rome:20261020T210000\nRRULE:FREQ=DAILY',
                'America/New_York',
                new Date('2026-11-16T10:00:00Z'),
            ),
        ).toThrow(BadRequestException);
    });

    it('leaves cron unchanged when normalizing', () => {
        expect(helper.normalizeRecurringSchedule('0 21 * * *', 'Europe/Rome', new Date())).toBe('0 21 * * *');
    });
});

describe('RecurringScheduleDto', () => {
    it('rejects an unknown time zone', async () => {
        const dto = new RecurringScheduleDto();
        dto.schedule = '0 21 * * *';
        dto.timezone = 'Mars/Base';
        const errors = await validate(dto);
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('timezone');
    });
});
