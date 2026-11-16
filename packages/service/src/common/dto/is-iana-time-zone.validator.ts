import { registerDecorator, ValidationOptions } from 'class-validator';

export function isIanaTimeZone(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
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
