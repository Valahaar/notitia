import { ScheduleRequestDto } from '../../../common/dto/schedule-request.dto';
import { IsObject, IsNotEmpty, IsBoolean } from 'class-validator';

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

}