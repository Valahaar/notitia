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
        this.logger.log('received-job-scheduling', scheduleRequestDto);

        const returnedJobId = await this.jobScheduler.scheduleJob(scheduleRequestDto);

        return returnedJobId;
    }

    async cancelScheduledJobProcessing(jobId: string, queue?: string): Promise<boolean> {
        this.logger.log(`received-cancel-job-scheduling: ${jobId} @ ${queue}`);
        const result = await this.jobScheduler.cancelJob(jobId, queue);
        if (result) {
            this.logger.log(`job-cancelled: ${jobId} @ ${queue}`);
        } else {
            this.logger.warn(`job-not-found: ${jobId} @ ${queue}`);
        }
        return result;
    }
}