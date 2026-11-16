import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isIanaTimeZone } from './is-iana-time-zone.validator';
import { RecurringScheduleDto } from './schedule-request.dto';

describe('isIanaTimeZone', () => {
    it('accepts region names and UTC', () => {
        expect(isIanaTimeZone('Europe/Rome')).toBe(true);
        expect(isIanaTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
        expect(isIanaTimeZone('Etc/GMT+1')).toBe(true);
        expect(isIanaTimeZone('UTC')).toBe(true);
    });

    it('rejects unknown names', () => {
        expect(isIanaTimeZone('Europe/Nowhere')).toBe(false);
        expect(isIanaTimeZone('')).toBe(false);
        expect(isIanaTimeZone(42)).toBe(false);
    });

    it('rejects offset-style and bare abbreviation zones that Intl accepts', () => {
        expect(isIanaTimeZone('+02:00')).toBe(false);
        expect(isIanaTimeZone('-0500')).toBe(false);
        expect(isIanaTimeZone('CET')).toBe(false);
    });

    it('makes an offset-style timezone a validation error (400), not a later 500', async () => {
        const dto = plainToInstance(RecurringScheduleDto, { type: 'recurring', schedule: '0 9 * * *', timezone: '+02:00' });

        const errors = await validate(dto);

        expect(errors.map((e) => e.property)).toContain('timezone');
    });
});
