import { Injectable, Inject, Logger } from '@nestjs/common';
import { ScheduleRequestDto } from '../../common/dto/schedule-request.dto';
import { IJobScheduler } from '../../common/interfaces/job-scheduler.interface';
import { JOB_SCHEDULER_TOKEN } from '../../common/constants';

@Injectable()
export class JobSchedulingService {
    private readonly logger = new Logger(JobSchedulingService.name);

    constructor(
        @Inject(JOB_SCHEDULER_TOKEN)
        private readonly jobScheduler: IJobScheduler,
    ) { }

    async scheduleJobProcessing(scheduleRequestDto: ScheduleRequestDto): Promise<string> {
        this.logger.log(
            {
                event: 'received-job-scheduling',
                target: scheduleRequestDto.target,
                method: scheduleRequestDto.method,
                schedule: scheduleRequestDto.schedule?.type ?? 'immediate',
                queue: scheduleRequestDto.queue,
            },
            'received-job-scheduling',
        );

        const returnedJobId = await this.jobScheduler.scheduleJob(scheduleRequestDto);

        return returnedJobId;
    }

    async cancelScheduledJobProcessing(jobId: string, queue?: string): Promise<boolean> {
        this.logger.log({ event: 'received-cancel-job-scheduling', jobId, queue }, 'received-cancel-job-scheduling');
        const result = await this.jobScheduler.cancelJob(jobId, queue);
        if (result) {
            this.logger.log({ event: 'job-cancelled', jobId, queue }, 'job-cancelled');
        } else {
            this.logger.warn({ event: 'job-not-found', jobId, queue }, 'job-not-found');
        }
        return result;
    }
}