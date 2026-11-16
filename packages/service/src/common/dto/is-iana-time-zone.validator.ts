import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * An IANA region name (`Area/Location`, e.g. `Europe/Rome`) or `UTC`. Intl also accepts offsets
 * (`+02:00`) and bare abbreviations (`CET`) that the schedule libraries then fail on (a 500), so
 * a name without `/` other than `UTC` is refused here (a 400).
 */
export function isIanaTimeZone(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value !== 'UTC' && !value.includes('/')) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

export function IsIanaTimeZone(validationOptions?: ValidationOptions) {
    return (object: object, propertyName: string) => {
        registerDecorator({
            name: 'isIanaTimeZone',
            target: object.constructor,
            propertyName,
            options: validationOptions,
            validator: {
                validate: (value: unknown) => isIanaTimeZone(value),
                defaultMessage: () => `${propertyName} must be a valid IANA time zone`,
            },
        });
    };
}
