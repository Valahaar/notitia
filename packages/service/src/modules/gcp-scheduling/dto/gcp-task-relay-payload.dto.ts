import { HttpMethod as AppHttpMethod } from '../../../common/dto/schedule-request.dto';
import { IsString, IsEnum, IsObject, IsOptional, IsNotEmpty } from 'class-validator';

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
}