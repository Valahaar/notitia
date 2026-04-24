import { Injectable, Logger, Inject, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IJobScheduler } from '../../common/interfaces/job-scheduler.interface';
import { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto, HttpMethod as AppHttpMethod, ScheduleType } from '../../common/dto/schedule-request.dto';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { GcpTaskRelayPayloadDto } from './dto/gcp-task-relay-payload.dto';
import { GCP_RELAY_PATH } from './gcp-task-relay.controller';
import { safeUrl } from '../../common/utils/log.util';

const GCP_MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
// const GCP_MAX_SCHEDULE_SECONDS = 30;

const generateNumericId = (length: number = 19): string => {
    return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
};

@Injectable()
export class GcpTaskSchedulerService implements IJobScheduler {
    private readonly logger = new Logger(GcpTaskSchedulerService.name);
    private cloudTasksClient: CloudTasksClient;
    private gcpProject: string;
    private gcpLocation: string;
    private gcpJobQueue: string; // For tasks targeting /relay
    private serviceUrl: string; // Base URL of this notification service
    private defaultTimeout?: number; // Seconds; undefined = use Cloud Tasks default (600s) for dispatch deadline

    constructor(
        private configService: ConfigService,
        private readonly scheduleHelperService: ScheduleHelperService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) {
        this.gcpProject = this.configService.get<string>('GCP_PROJECT_ID')!;
        this.gcpLocation = this.configService.get<string>('GCP_LOCATION_ID')!;
        this.gcpJobQueue = this.configService.get<string>('GCP_JOB_QUEUE_NAME')!;
        this.serviceUrl = this.configService.get<string>('NOTIFICATION_SERVICE_URL')!;

        const rawTimeout = Number(this.configService.get<string>('DEFAULT_TIMEOUT_SECONDS'));
        if (Number.isFinite(rawTimeout) && rawTimeout >= 15 && rawTimeout <= 1800) {
            this.defaultTimeout = Math.floor(rawTimeout);
        }

        const missingEnvVars = [
            !this.gcpProject && 'GCP_PROJECT_ID',
            !this.gcpLocation && 'GCP_LOCATION_ID',
            !this.gcpJobQueue && 'GCP_JOB_QUEUE_NAME',
            !this.serviceUrl && 'NOTIFICATION_SERVICE_URL'
        ].filter(Boolean);

        if (missingEnvVars.length > 0) {
            throw new Error(`Missing environment variables: ${missingEnvVars.join(', ')}. Cannot initialize GcpTaskSchedulerService.`);
        }

        if (!this.serviceUrl.endsWith('/')) {
            this.serviceUrl += '/';
        }

        this.cloudTasksClient = new CloudTasksClient();
    }

    getQueueName(queueName?: string): string {
        return queueName ?? this.gcpJobQueue;
    }

    getMetaQueueName(queueName?: string): string {
        return `meta-${this.getQueueName(queueName)}`;
    }

    async delUfid(ufid: string, queueName?: string): Promise<void> {
        await this.cacheManager.del(this.getCacheKeyForJob(ufid, queueName));
    }

    async getIdFromUfid(ufid: string, queueName?: string): Promise<string | null> {
        return await this.cacheManager.get<string>(this.getCacheKeyForJob(ufid, queueName));
    }

    async setIdForUfid(ufid: string, id: string, queueName?: string): Promise<void> {
        await this.cacheManager.set(this.getCacheKeyForJob(ufid, queueName), id);
    }

    private getCacheKeyForJob(jobId: string, queueName?: string): string {
        return `gcp_job:${this.getQueueName(queueName)}:${jobId}`;
    }

    private getQueuePath(queueName: string): string {
        return this.cloudTasksClient.queuePath(this.gcpProject, this.gcpLocation, queueName);
    }

    private getTaskPath(queueName: string, taskName: string): string {
        // Task names must be unique within a queue. They can be up to 500 characters.
        // Allowed characters: A-Z, a-z, 0-9, hyphen (-), underscore (_).
        // For direct tasks, we might use the generated ID. For meta tasks, the UFID.
        return this.cloudTasksClient.taskPath(this.gcpProject, this.gcpLocation, queueName, taskName);
    }

    public async createTask(queueName: string, url: string, payload: any, scheduleTime?: Date, taskName?: string, timeoutSeconds?: number): Promise<string> {
        const body = Buffer.from(JSON.stringify(payload));

        // Get the authentication token from environment
        const authToken = this.configService.get<string>('AUTH_TOKEN');
        if (!authToken) {
            throw new Error('AUTH_TOKEN environment variable not configured');
        }

        const task: protos.google.cloud.tasks.v2.ITask = {
            httpRequest: {
                httpMethod: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: body,
            },
        };

        if (taskName) {
            task.name = this.getTaskPath(queueName, taskName);
        }

        if (scheduleTime) {
            task.scheduleTime = {
                seconds: Math.floor(scheduleTime.getTime() / 1000),
            };
        }

        if (timeoutSeconds) {
            // Cloud Tasks calls this `dispatchDeadline`; we surface it as `timeout` in the public API.
            task.dispatchDeadline = { seconds: timeoutSeconds };
        }

        try {
            const [response] = await this.cloudTasksClient.createTask({ parent: this.getQueuePath(queueName), task });
            return response.name?.split('/').at(-1)!;
        } catch (error: any) {
            if (error.hasOwnProperty('code') && error.hasOwnProperty('details')) {
                const details = error.details;
                this.logger.error(
                    { queueName, url: safeUrl(url), scheduleTime: scheduleTime?.toISOString() ?? 'now', code: error.code, details },
                    'Error creating GCP task',
                );
                throw new HttpException(details, 400);
            }
            throw error;
        }
    }

    /**
     * Creates a GCP task targeting the /relay endpoint.
     * The payload for this task is GcpTaskRelayPayloadDto.
     * Used for immediate/short-term jobs, or by MetaService to execute a job instance.
     * Returns the GCP task ID (numeric part) or undefined on failure.
     */
    public async createRelayEndpointTask(
        originalRequest: ScheduleRequestDto,
        scheduleTime?: Date, // If undefined, task is scheduled for ASAP.
    ): Promise<string | undefined> {
        const effectiveTimeout = originalRequest.timeout ?? this.defaultTimeout;

        const relayPayload: GcpTaskRelayPayloadDto = {
            target: originalRequest.target,
            method: originalRequest.method || AppHttpMethod.POST,
            payload: originalRequest.payload,
            headers: originalRequest.headers,
            params: originalRequest.params,
            timeout: effectiveTimeout,
        };

        return await this.createTask(
            this.getQueueName(originalRequest.queue),
            `${this.serviceUrl}${GCP_RELAY_PATH}`,
            relayPayload,
            scheduleTime,
            undefined,
            effectiveTimeout,
        );
    }

    /**
     * Creates a GCP task targeting the /meta/{UFID} endpoint.
     * The payload for this task is the original ScheduleRequestDto.
     * Used for long-term or recurring jobs.
     * Returns the GCP task ID (numeric part) or undefined on failure.
     */
    public async createMetaEndpointTask(
        ufid: string,
        originalRequest: ScheduleRequestDto & { isOccurrence?: boolean },
        scheduleTime: Date,
    ): Promise<string | undefined> {

        return await this.createTask(
            this.getMetaQueueName(originalRequest.queue),
            `${this.serviceUrl}meta/${ufid}`,
            originalRequest,
            scheduleTime,
        );
    }

    private static restrictScheduleTime(scheduleTime: Date | undefined): Date | undefined {
        if (!scheduleTime) {
            return undefined;
        }

        const now = new Date();
        const maxDelayFromNow = new Date(now.getTime() + GCP_MAX_SCHEDULE_SECONDS * 1000);
        return scheduleTime > maxDelayFromNow ? maxDelayFromNow : scheduleTime;
    }

    /**
     * Computes the next execution time for a schedule request.
     * Returns the next execution time for the schedule request, the actual next execution time, and whether the schedule is recurring.
     */
    public computeNextExecutionTime(req: ScheduleRequestDto): { nextExecutionTime: Date | undefined, realNextExecutionTime: Date | undefined, recurring: boolean, nextIsOccurrence: boolean } {
        const { schedule } = req;

        if (!schedule) {
            return { nextExecutionTime: undefined, realNextExecutionTime: undefined, recurring: false, nextIsOccurrence: false };
        }

        // this one takes into account the max delay allowed by GCP
        let nextExecutionTime: Date | undefined;

        // this one is the actual next execution time for the schedule request
        let realNextExecutionTime: Date | undefined;

        let recurring = false;
        if (schedule.type === ScheduleType.RECURRING) {
            realNextExecutionTime = this.scheduleHelperService.calculateNextOccurrence((schedule as RecurringScheduleDto).schedule, new Date()) || undefined;
            recurring = true;
        } else if (schedule.type === ScheduleType.ON) {
            realNextExecutionTime = new Date((schedule as OneTimeScheduleDto).time);
        } else {
            throw new Error(`Invalid schedule type: ${schedule.type}`);
        }

        nextExecutionTime = GcpTaskSchedulerService.restrictScheduleTime(realNextExecutionTime);

        return { nextExecutionTime, realNextExecutionTime, recurring, nextIsOccurrence: nextExecutionTime?.getTime() === realNextExecutionTime?.getTime() };
    }

    async scheduleInternal(request: ScheduleRequestDto): Promise<{ ufid?: string, gcpTaskId: string }> {
        const { nextExecutionTime, recurring, nextIsOccurrence } = this.computeNextExecutionTime(request);

        // cases in which we need to schedule a meta-job:
        // - recurring job
        // - one-time job that's not schedulable within 30 days

        // if the next execution time is the same as the real next execution time, we can schedule directly to the relay (no need for a meta-job)
        if (!recurring && ((nextExecutionTime && nextIsOccurrence) || !nextExecutionTime)) {
            const gcpTaskId = await this.createRelayEndpointTask(request, nextExecutionTime);
            if (!gcpTaskId) {
                throw new Error(`Failed to schedule direct relay task for ${safeUrl(request.target)}`);
            }
            this.logger.log(
                { gcpTaskId, scheduleTime: nextExecutionTime?.toISOString() ?? 'ASAP', target: safeUrl(request.target) },
                'Scheduled direct relay',
            );

            // For direct tasks, the user-facing ID is the generated task ID we passed to the relay
            return { ufid: undefined, gcpTaskId };
        } else {
            if (!nextExecutionTime) {
                throw new Error(`[${safeUrl(request.target)}] Next execution time is undefined. Cannot schedule meta-job.`);
            }

            // Long-term one-time job OR any recurring job: create UFID and schedule a meta-job
            const ufid = generateNumericId();
            this.logger.log(
                { ufid, recurring, scheduleTime: nextExecutionTime!.toISOString(), target: safeUrl(request.target) },
                'Scheduling meta-job',
            );

            const gcpMetaTaskId = await this.createMetaEndpointTask(ufid, { ...request, isOccurrence: nextIsOccurrence }, nextExecutionTime!);
            if (!gcpMetaTaskId) {
                throw new Error(`[${ufid}] Failed to schedule meta-job task for ${safeUrl(request.target)}`);
            }

            await this.setIdForUfid(ufid, gcpMetaTaskId, request.queue); // Store UFID -> GCP Meta Task ID (RID)
            this.logger.log(
                { ufid, gcpTaskId: gcpMetaTaskId },
                'Meta-job scheduled',
            );
            return { ufid, gcpTaskId: gcpMetaTaskId };
        }
    }

    async scheduleJob(request: ScheduleRequestDto): Promise<string> {
        const { ufid, gcpTaskId } = await this.scheduleInternal(request);
        // if UFID is not undefined, it means we scheduled a meta-job
        // otherwise, we scheduled a direct relay task
        return ufid || gcpTaskId;
    }

    async cancelJob(jobId: string, queueName?: string): Promise<boolean> { // jobId can be UFID or direct GCP Task ID
        this.logger.log(
            { jobId },
            'Attempting to cancel job',
        );

        const gcpTaskIdFromCache = await this.getIdFromUfid(jobId);
        const qName = this.getQueueName(queueName);
        const queue = gcpTaskIdFromCache ? this.getMetaQueueName(qName) : qName;
        const actualJobId = gcpTaskIdFromCache || jobId;

        const name = this.getTaskPath(queue, actualJobId);

        const successful = await this.cloudTasksClient.deleteTask({ name }).then(() => true).catch((err) => {
            if (err.code === 5) { // NOT_FOUND error code from GCP
                this.logger.warn(
                    { jobId, taskName: name },
                    'GCP task not found',
                );
                return false;
            }
            throw err;
        });

        if (gcpTaskIdFromCache) {
            await this.delUfid(jobId);
            this.logger.log(
                { jobId },
                'Cleared UFID from cache as its tracked task was successfully cancelled',
            );
        }

        return successful;
    }
}