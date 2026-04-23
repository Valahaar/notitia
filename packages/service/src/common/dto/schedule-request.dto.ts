import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsString,
    IsObject,
    IsOptional,
    IsUrl,
    ValidateNested,
    IsEnum,
    IsISO8601,
    IsInt,
    Min,
    Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ScheduleType {
    ON = 'on',
    RECURRING = 'recurring',
}

export enum HttpMethod {
    POST = 'POST',
    GET = 'GET',
    PUT = 'PUT',
    DELETE = 'DELETE',
    PATCH = 'PATCH',
}

export class ScheduleBaseDto {
    @ApiProperty({ enum: ScheduleType, description: "Type of schedule: 'on' for one-time, 'recurring' for recurring." })
    @IsEnum(ScheduleType)
    type: ScheduleType;
}

export class OneTimeScheduleDto extends ScheduleBaseDto {
    @ApiProperty({ type: String, format: 'date-time', description: 'ISO 8601 datetime string in UTC for one-time events.' })
    @IsISO8601()
    time: string;

    @ApiProperty({ enum: [ScheduleType.ON], default: ScheduleType.ON })
    type: ScheduleType.ON = ScheduleType.ON;
}

export class RecurringScheduleDto extends ScheduleBaseDto {
    @ApiProperty({ type: String, description: 'CRON string or RRule string for recurring events.' })
    @IsString()
    schedule: string;

    @ApiProperty({ enum: [ScheduleType.RECURRING], default: ScheduleType.RECURRING })
    type: ScheduleType.RECURRING = ScheduleType.RECURRING;
}

export class ScheduleRequestDto<T extends ScheduleBaseDto = ScheduleBaseDto> {
    @ApiPropertyOptional({
        oneOf: [
            { $ref: '#/components/schemas/OneTimeScheduleDto' },
            { $ref: '#/components/schemas/RecurringScheduleDto' },
        ],
        description: 'Schedule for the HTTP call. If omitted, the call is made immediately.',
        required: false,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => Object, {
        discriminator: {
            property: 'type',
            subTypes: [
                { value: OneTimeScheduleDto, name: ScheduleType.ON },
                { value: RecurringScheduleDto, name: ScheduleType.RECURRING },
            ],
        },
        keepDiscriminatorProperty: true,
    })
    schedule?: T;

    @ApiProperty({ example: 'https://example.com/webhook', description: 'URL to be called.' })
    @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
    target: string;

    @ApiProperty({ example: 'default', description: 'Queue to be used for the HTTP call. If omitted, the default Notitia queue is used.' })
    @IsString()
    @IsOptional()
    queue?: string;

    @ApiPropertyOptional({ enum: HttpMethod, default: HttpMethod.POST, description: 'HTTP method.' })
    @IsOptional()
    @IsEnum(HttpMethod)
    method?: HttpMethod = HttpMethod.POST;

    @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'JSON payload for the HTTP request.' })
    @IsOptional()
    @IsObject()
    payload?: Record<string, any>;

    @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Key-value pairs for HTTP headers.' })
    @IsOptional()
    @IsObject()
    headers?: Record<string, string>;

    @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Key-value pairs for URL query parameters.' })
    @IsOptional()
    @IsObject()
    params?: Record<string, string>;

    @ApiPropertyOptional({
        type: Number,
        minimum: 15,
        maximum: 1800,
        description: 'Maximum duration in seconds the target HTTP call is allowed to run before it is cancelled and retried. Maps to Cloud Tasks dispatch deadline when using the GCP scheduler; GCP accepts 15–1800 (30 min). If omitted, the service default (DEFAULT_TIMEOUT_SECONDS) is used, else Cloud Tasks defaults to 600s.',
    })
    @IsOptional()
    @IsInt()
    @Min(15)
    @Max(1800)
    timeout?: number;
}