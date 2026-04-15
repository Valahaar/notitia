import { ScheduleRequestDto } from '../dto/schedule-request.dto';

export interface IJobScheduler {
    /**
     * Schedules an HTTP call to be made to the target.
     * @param request The schedule request, using ScheduleRequestDto.
     * @returns A job identifier string (UFID for meta-jobs, or direct GCP task ID for immediate/short-term jobs).
     */
    scheduleJob(request: ScheduleRequestDto): Promise<string>;

    /**
     * Cancels a previously scheduled job.
     * @param jobId The identifier of the job to cancel (this is the ID returned by scheduleJob).
     * @returns True if cancellation was successful or job was already gone/processed, false otherwise.
     */
    cancelJob(jobId: string, queue?: string): Promise<boolean>;

}