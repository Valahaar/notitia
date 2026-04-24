import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IJobScheduler } from '../../common/interfaces/job-scheduler.interface';
import { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto, ScheduleType } from '../../common/dto/schedule-request.dto';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { HttpExecutorService } from '../../common/services/http-executor.service';
import { v4 as uuidv4 } from 'uuid';
import { safeUrl } from '../../common/utils/log.util';

interface InMemoryJob {
    timeoutId?: NodeJS.Timeout;
    originalRequest: ScheduleRequestDto;
    isRecurring: boolean;
}

@Injectable()
export class InMemorySchedulerService implements IJobScheduler, OnModuleDestroy {
    private readonly logger = new Logger(InMemorySchedulerService.name);
    private jobs = new Map<string, InMemoryJob>();

    constructor(
        private readonly scheduleHelperService: ScheduleHelperService,
        private readonly httpExecutor: HttpExecutorService,
    ) { }

    async scheduleJob(request: ScheduleRequestDto): Promise<string> {
        const jobId = uuidv4();
        const scheduleType = request.schedule?.type;

        // Cancel any existing job with the same ID (e.g. if rescheduling a recurring job's next instance)
        // This is important for recurring jobs where scheduleNextRecurringInstance might be called multiple times
        // for the same conceptual recurring job, but we only want one active timeout for it.
        if (this.jobs.has(jobId)) {
            this.logger.warn(
                { jobId },
                'Job with this ID already exists. Cancelling previous one before scheduling new one.',
            );
            this.clearJob(jobId);
        }

        if (!scheduleType) {
            this.handleOneTimeSchedule(jobId, { ...request, schedule: { type: ScheduleType.ON, time: new Date().toISOString() } as OneTimeScheduleDto } as ScheduleRequestDto<OneTimeScheduleDto>);
        } else if (scheduleType === ScheduleType.ON) {
            this.handleOneTimeSchedule(jobId, request as ScheduleRequestDto<OneTimeScheduleDto>);
        } else if (scheduleType === ScheduleType.RECURRING) {
            this.handleRecurringSchedule(jobId, request as ScheduleRequestDto<RecurringScheduleDto>);
        } else {
            this.logger.warn(
                { jobId, scheduleType },
                'Unsupported schedule type',
            );
        }
        return jobId; // Return the jobId (UUID in this case)
    }

    private handleOneTimeSchedule(jobId: string, request: ScheduleRequestDto<OneTimeScheduleDto>): void {
        const targetTime = new Date(request.schedule!.time);
        const now = new Date();
        const delay = targetTime.getTime() - now.getTime();

        if (delay <= 0) {
            this.executeJob(jobId, request);
        } else {
            this.logger.log(
                { jobId, scheduledFor: targetTime.toISOString(), target: safeUrl(request.target) },
                'Job scheduled',
            );
            const timeoutId = setTimeout(() => {
                this.executeJob(jobId, request);
                this.jobs.delete(jobId);
            }, delay);
            this.jobs.set(jobId, { timeoutId, originalRequest: request, isRecurring: false });
        }
    }

    private handleRecurringSchedule(jobId: string, request: ScheduleRequestDto<RecurringScheduleDto>): void {
        this.jobs.set(jobId, {
            originalRequest: request,
            isRecurring: true
        });

        this.scheduleNextRecurringInstance(jobId, request);
    }

    private scheduleNextRecurringInstance(jobId: string, originalRecurringRequest: ScheduleRequestDto<RecurringScheduleDto>): void {
        let nextOccurrence: Date | null = null;
        const now = new Date();

        try {
            nextOccurrence = this.scheduleHelperService.calculateNextOccurrence(originalRecurringRequest.schedule!.schedule, now);
        } catch (err) {
            this.logger.error(
                { jobId, scheduleString: originalRecurringRequest.schedule!.schedule, target: safeUrl(originalRecurringRequest.target), error: String(err) },
                'Error calculating next occurrence for recurring schedule',
            );
            this.jobs.delete(jobId); // Stop trying if schedule is bad
            return;
        }

        if (nextOccurrence) {
            const delay = nextOccurrence.getTime() - now.getTime();
            this.logger.log(
                { jobId, nextOccurrence: nextOccurrence.toISOString(), target: safeUrl(originalRecurringRequest.target) },
                'Next recurring instance scheduled',
            );

            if (delay < 0) {
                this.logger.warn(
                    { jobId },
                    'Next occurrence is in the past, finding next future occurrence',
                );
                const futureOccurrence = this.findNextFutureOccurrence(originalRecurringRequest.schedule!.schedule, now);
                if (futureOccurrence) {
                    this.scheduleNextRecurringInstanceWithDate(jobId, originalRecurringRequest, futureOccurrence);
                } else {
                    this.logger.log(
                        { jobId },
                        'No more future occurrences, removing recurring job',
                    );
                    this.jobs.delete(jobId);
                }
                return;
            }

            const timeoutId = setTimeout(() => {
                this.executeJob(jobId + '-' + new Date().getTime(), originalRecurringRequest);
                this.scheduleNextRecurringInstance(jobId, originalRecurringRequest);
            }, delay);

            const jobData = this.jobs.get(jobId);
            if (jobData) {
                jobData.timeoutId = timeoutId;
            } else {
                this.logger.error(
                    { jobId },
                    'Job data not found when setting timeout, creating new entry',
                );
                this.jobs.set(jobId, { timeoutId, originalRequest: originalRecurringRequest, isRecurring: true });
            }
        } else {
            this.logger.log(
                { jobId },
                'No more occurrences, removing recurring job',
            );
            this.jobs.delete(jobId);
        }
    }

    private findNextFutureOccurrence(scheduleString: string, fromDate: Date): Date | null {
        try {
            return this.scheduleHelperService.calculateNextOccurrence(scheduleString, fromDate, false);
        } catch (err) {
            this.logger.error(
                { scheduleString, error: String(err) },
                'Error finding next future occurrence for schedule',
            );
            return null;
        }
    }

    private scheduleNextRecurringInstanceWithDate(jobId: string, originalRecurringRequest: ScheduleRequestDto<RecurringScheduleDto>, nextOccurrence: Date): void {
        const now = new Date();
        const delay = nextOccurrence.getTime() - now.getTime();

        if (delay < 0) {
            this.logger.error(
                { jobId },
                'Adjusted delay still negative, aborting recurring job',
            );
            this.jobs.delete(jobId);
            return;
        }

        this.logger.log(
            { jobId, nextOccurrence: nextOccurrence.toISOString(), target: safeUrl(originalRecurringRequest.target) },
            'Adjusted next recurring instance scheduled',
        );

        const timeoutId = setTimeout(() => {
            this.executeJob(jobId + '-' + new Date().getTime(), originalRecurringRequest);
            this.scheduleNextRecurringInstance(jobId, originalRecurringRequest);
        }, delay);

        const jobData = this.jobs.get(jobId);
        if (jobData) {
            jobData.timeoutId = timeoutId;
        } else {
            this.logger.error(
                { jobId },
                'Job data not found when setting adjusted timeout',
            );
            this.jobs.set(jobId, { timeoutId, originalRequest: originalRecurringRequest, isRecurring: true });
        }
    }

    private async executeJob(jobId: string, request: ScheduleRequestDto, attempt = 1): Promise<void> {
        const maxRetries = 3;

        try {
            const result = await this.httpExecutor.executeHttpRequest({
                taskId: jobId,
                target: request.target,
                method: request.method,
                payload: request.payload,
                headers: request.headers,
                params: request.params,
                timeoutSeconds: request.timeout,
            });

            if (!result.success && attempt < maxRetries) {
                const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s
                this.logger.warn(
                { jobId, status: result.status, delayMs: delay, attempt, maxRetries },
                'Execution failed, retrying',
            );
                setTimeout(() => this.executeJob(jobId, request, attempt + 1), delay);
            }
        } catch (error) {
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
                this.logger.warn(
                    { jobId, delayMs: delay, attempt, maxRetries },
                    'Execution threw error, retrying',
                );
                setTimeout(() => this.executeJob(jobId, request, attempt + 1), delay);
            } else {
                this.logger.error(
                    { jobId, maxRetries },
                    'Job execution failed after max retries',
                );
            }
        }
    }

    async cancelJob(jobId: string): Promise<boolean> {
        this.logger.log(
            { jobId },
            'Attempting to cancel job',
        );
        return this.clearJob(jobId);
    }

    private clearJob(jobId: string): boolean {
        const job = this.jobs.get(jobId);
        if (job) {
            if (job.timeoutId) {
                clearTimeout(job.timeoutId);
            }
            this.jobs.delete(jobId);
            this.logger.log(
                { jobId },
                'Job cancelled and removed',
            );
            return true;
        }
        this.logger.warn(
            { jobId },
            'Job not found for cancellation',
        );
        return false;
    }

    onModuleDestroy() {
        this.logger.log('Clearing all in-memory scheduled jobs as module is being destroyed.');
        this.jobs.forEach(job => {
            if (job.timeoutId) {
                clearTimeout(job.timeoutId);
            }
        });
        this.jobs.clear();
    }
}