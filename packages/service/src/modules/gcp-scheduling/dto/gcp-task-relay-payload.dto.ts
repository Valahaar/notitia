import { HttpMethod as AppHttpMethod } from '../../../common/dto/schedule-request.dto';
import { IsString, IsEnum, IsObject, IsOptional, IsNotEmpty, IsInt, Min, Max } from 'class-validator';

export class GcpTaskRelayPayloadDto {
    @IsString()
    @IsNotEmpty()
    target: string;

    @IsEnum(AppHttpMethod)
    method: AppHttpMethod;

    @IsObject()
    @IsOptional()
    payload?: Record<string, any>;

    @IsObject()
    @IsOptional()
    headers?: Record<string, string>;

    @IsObject()
    @IsOptional()
    params?: Record<string, any>;

    @IsOptional()
    @IsInt()
    @Min(15)
    @Max(1800)
    timeout?: number;
}