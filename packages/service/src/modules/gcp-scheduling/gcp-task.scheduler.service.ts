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
import { CloudTasksClientHolder, isBareInvalidArgument } from './cloud-tasks-client.holder';
import { taskNameFor } from './task-name';
import { randomUUID } from 'crypto';
import { NOTITIA_OCCURRENCE_HEADER } from '../../common/constants';

const GCP_MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
// const GCP_MAX_SCHEDULE_SECONDS = 30;

const generateNumericId = (length: number = 19): string => {
    return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
};

// Maps gRPC status codes (google.rpc.Code) to HTTP status codes, following the
// standard grpc-gateway table. Transient / server-side failures (RESOURCE_EXHAUSTED,
// UNAVAILABLE, DEADLINE_EXCEEDED, INTERNAL) map to retryable 429/5xx rather than a
// blanket 400, so callers — and the SDK's 429/5xx retry — don't treat a GCP hiccup as
// a non-retryable bad request. Unknown codes default to 500 (retryable, safest).
const GRPC_CODE_TO_HTTP_STATUS: Record<number, number> = {
    2: 500,  // UNKNOWN
    3: 400,  // INVALID_ARGUMENT
    4: 504,  // DEADLINE_EXCEEDED
    5: 404,  // NOT_FOUND
    6: 409,  // ALREADY_EXISTS
    7: 403,  // PERMISSION_DENIED
    8: 429,  // RESOURCE_EXHAUSTED
    9: 400,  // FAILED_PRECONDITION
    10: 409, // ABORTED
    11: 400, // OUT_OF_RANGE
    13: 500, // INTERNAL
    14: 503, // UNAVAILABLE
    15: 500, // DATA_LOSS
    16: 401, // UNAUTHENTICATED
};

@Injectable()
export class GcpTaskSchedulerService implements IJobScheduler {
    private readonly logger = new Logger(GcpTaskSchedulerService.name);
    // Owns the CloudTasksClient (lazy build, keepalive, per-attempt deadline, rebuild + retry
    // on dead channels, bare INVALID_ARGUMENT retry). See cloud-tasks-client.holder.ts.
    private clientHolder: CloudTasksClientHolder;
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

        this.clientHolder = new CloudTasksClientHolder();
    }

    private getClient(): Promise<CloudTasksClient> {
        return this.clientHolder.get();
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

    private async getQueuePath(queueName: string): Promise<string> {
        const client = await this.getClient();
        return client.queuePath(this.gcpProject, this.gcpLocation, queueName);
    }

    private async getTaskPath(queueName: string, taskName: string): Promise<string> {
        // Task names must be unique within a queue. They can be up to 500 characters.
        // Allowed characters: A-Z, a-z, 0-9, hyphen (-), underscore (_).
        // For direct tasks, we might use the generated ID. For meta tasks, the UFID.
        const client = await this.getClient();
        return client.taskPath(this.gcpProject, this.gcpLocation, queueName, taskName);
    }

    public async createTask(queueName: string, url: string, payload: any, scheduleTime: Date | undefined, taskName: string, timeoutSeconds?: number): Promise<string> {
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
            name: await this.getTaskPath(queueName, taskName),
        };

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
            const parent = await this.getQueuePath(queueName);
            // Every task is named, so a create that was retried (or whose response was lost)
            // answers ALREADY_EXISTS, which is success: the task is there.
            const [response] = await this.clientHolder.call('createTask', (c, o) => c.createTask({ parent, task }, o));
            return response.name?.split('/').at(-1)!;
        } catch (error: any) {
            if (error?.code === 6) {
                this.logger.log({ queueName, taskName }, 'cloud-tasks-task-already-exists');
                return taskName;
            }
            if (error && error.hasOwnProperty('code') && error.hasOwnProperty('details')) {
                const details = error.details;
                // Reaching here with a bare INVALID_ARGUMENT means the holder's retries were exhausted.
                const status = isBareInvalidArgument(error) ? 503 : (GRPC_CODE_TO_HTTP_STATUS[error.code] ?? 500);

                // Diagnostics run INSIDE the catch, so a throw here would escape and turn
                // the intended 400 into a 500. Isolate all enrichment + logging in its own
                // try/catch and unconditionally fall through to the HttpException below —
                // logging must never affect the response.
                try {
                    // GCP's `details` string is generic ("Request contains an invalid
                    // argument."). The rich, field-level cause lives in the gRPC status
                    // details / metadata — capture them so the offending argument is named
                    // instead of guessed at. `statusDetails` (decoded by google-gax) carries
                    // a google.rpc.BadRequest whose `fieldViolations` point at the exact field.
                    const statusDetails = error.statusDetails;
                    const fieldViolations = Array.isArray(statusDetails)
                        ? statusDetails.flatMap((d: any) => d?.fieldViolations ?? [])
                        : undefined;
                    const metadata = typeof error.metadata?.getMap === 'function' ? error.metadata.getMap() : undefined;

                    // Shape of the task we tried to create, so failures can be correlated
                    // against the documented createTask limits (1 MiB task size, <80KB
                    // headers, 30-day schedule horizon, 15s-30min dispatch deadline) and the
                    // trailing-whitespace-in-AUTH_TOKEN case — without logging the token.
                    const authHeader = task.httpRequest?.headers?.['Authorization'] ?? '';
                    const body = task.httpRequest?.body;
                    const taskShape = {
                        hasName: !!task.name,
                        scheduleTimeSeconds: task.scheduleTime?.seconds ?? null,
                        dispatchDeadlineSeconds: task.dispatchDeadline?.seconds ?? null,
                        bodyBytes: typeof body === 'string' ? Buffer.byteLength(body) : (body?.length ?? 0),
                        headerNames: Object.keys(task.httpRequest?.headers ?? {}),
                        authHeaderLength: authHeader.length,
                        authHeaderHasTrailingWhitespace: /\s$/.test(authHeader),
                        authHeaderHasControlChars: /[\x00-\x1f\x7f]/.test(authHeader),
                    };

                    this.logger.error(
                        {
                            queueName,
                            url: safeUrl(url),
                            scheduleTime: scheduleTime?.toISOString() ?? 'now',
                            code: error.code,
                            httpStatus: status,
                            details,
                            message: error.message,
                            fieldViolations,
                            statusDetails,
                            metadata,
                            taskShape,
                        },
                        'Error creating GCP task',
                    );
                } catch {
                    // Enrichment or serialization failed — emit a minimal, primitive-only
                    // log so the failure is still recorded, then continue to the 400.
                    this.logger.error({ queueName, code: error.code, httpStatus: status, details }, 'Error creating GCP task (diagnostics unavailable)');
                }
                throw new HttpException(details, status);
            }
            // Errors without gRPC code/details would otherwise propagate as an opaque
            // 500 with nothing logged — surface them too, without letting logging mask them.
            try {
                this.logger.error({ queueName, url: safeUrl(url), err: error }, 'Unexpected error creating GCP task');
            } catch {
                // never let a logging failure replace the original error
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
        taskName?: string,
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
            taskName ?? taskNameFor(['req', randomUUID()]),
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
        originalRequest: ScheduleRequestDto & { isOccurrence?: boolean; occurrence?: string },
        scheduleTime: Date,
        taskName?: string,
    ): Promise<string | undefined> {

        return await this.createTask(
            this.getMetaQueueName(originalRequest.queue),
            `${this.serviceUrl}meta/${ufid}`,
            originalRequest,
            scheduleTime,
            taskName ?? taskNameFor(['req', randomUUID()]),
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
            const recurringSchedule = schedule as RecurringScheduleDto;
            realNextExecutionTime = this.scheduleHelperService.calculateNextOccurrence(recurringSchedule.schedule, new Date(), {
                timezone: recurringSchedule.timezone,
            }) || undefined;
            recurring = true;
        } else if (schedule.type === ScheduleType.ON) {
            realNextExecutionTime = new Date((schedule as OneTimeScheduleDto).time);
        } else {
            throw new Error(`Invalid schedule type: ${schedule.type}`);
        }

        nextExecutionTime = GcpTaskSchedulerService.restrictScheduleTime(realNextExecutionTime);

        return { nextExecutionTime, realNextExecutionTime, recurring, nextIsOccurrence: nextExecutionTime?.getTime() === realNextExecutionTime?.getTime() };
    }

    /** Returns the request with `X-Notitia-Occurrence` set to the occurrence time (ISO-8601 UTC). */
    public withOccurrenceHeader<T extends ScheduleRequestDto>(request: T, occurrence: Date | string): T {
        const iso = typeof occurrence === 'string' ? occurrence : occurrence.toISOString();
        return { ...request, headers: { ...(request.headers || {}), [NOTITIA_OCCURRENCE_HEADER]: iso } };
    }

    async scheduleInternal(requestIn: ScheduleRequestDto): Promise<{ ufid?: string, gcpTaskId: string }> {
        // Anchor an RRULE without DTSTART once, here; every later hop carries the anchored rule and timezone.
        let request = requestIn;
        if (requestIn.schedule?.type === ScheduleType.RECURRING) {
            const recurring = requestIn.schedule as RecurringScheduleDto;
            const anchored: RecurringScheduleDto = {
                ...recurring,
                schedule: this.scheduleHelperService.normalizeRecurringSchedule(recurring.schedule, recurring.timezone, new Date()),
            };
            request = { ...requestIn, schedule: anchored };
        }

        const { nextExecutionTime, realNextExecutionTime, recurring, nextIsOccurrence } = this.computeNextExecutionTime(request);

        // cases in which we need to schedule a meta-job:
        // - recurring job
        // - one-time job that's not schedulable within 30 days

        // if the next execution time is the same as the real next execution time, we can schedule directly to the relay (no need for a meta-job)
        if (!recurring && ((nextExecutionTime && nextIsOccurrence) || !nextExecutionTime)) {
            const taskName = request.idempotencyKey
                ? taskNameFor(['key', this.getQueueName(request.queue), request.idempotencyKey])
                : undefined;
            // A scheduled direct relay knows its occurrence at create time; an immediate one has none.
            const relayRequest = nextExecutionTime ? this.withOccurrenceHeader(request, nextExecutionTime) : request;
            const gcpTaskId = await this.createRelayEndpointTask(relayRequest, nextExecutionTime, taskName);
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

            const gcpMetaTaskId = await this.createMetaEndpointTask(ufid, { ...request, isOccurrence: nextIsOccurrence, occurrence: realNextExecutionTime?.toISOString() }, nextExecutionTime!);
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

        const name = await this.getTaskPath(queue, actualJobId);

        const successful = await this.clientHolder.call('deleteTask', (c, o) => c.deleteTask({ name }, o)).then(() => true).catch((err) => {
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