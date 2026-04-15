import { ApiProperty } from '@nestjs/swagger';

export class ScheduleJobResponseDto {
    @ApiProperty({ description: 'The unique identifier of the scheduled job.', example: 'c7a0b6e0-0b7a-4a0e-8b0a-0b7a4a0e8b0a' })
    jobId: string;
}