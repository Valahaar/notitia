import { ScheduleRequestDto } from '../../../common/dto/schedule-request.dto';
import { IsObject, IsNotEmpty, IsBoolean, IsString, IsOptional } from 'class-validator';

export class GcpMetaTaskPayloadDto extends ScheduleRequestDto {

    @IsObject()
    @IsNotEmpty()
    meta: {
        queue: string;
        ufid: string; // UFID of the meta-job.
    };

    @IsBoolean()
    @IsNotEmpty()
    isOccurrence: boolean;

    /** ISO-8601 UTC time of the occurrence this task serves. `isOccurrence` stays for old readers. */
    @IsString()
    @IsOptional()
    occurrence?: string;

}