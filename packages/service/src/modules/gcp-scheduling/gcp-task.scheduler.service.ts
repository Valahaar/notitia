import { Injectable, Logger, Inject, HttpException, ConflictException } from '@nestjs/common';
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
import { createHash, randomUUID } from 'crypto';
import { NOTITIA_OCCURRENCE_HEADER } from '../../common/constants';

export const GCP_MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
// const GCP_MAX_SCHEDULE_SECONDS = 30;

/** A tombstone outlives a 30-day hop plus the meta queue's retry window. */
export const TOMBSTONE_TTL_MS = 60 * 24 * 3600 * 1000;

const UFID_DIGITS = 19;
/** The shape of a ufid (and of a v1.3.4 direct task's auto id). Only such ids reach the cache on cancel. */
const UFID_SHAPE = /^\d{19}$/;

const generateNumericId = (length: number = UFID_DIGITS): string => {
    return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
};

/**
 * The ufid of a keyed recurring or long one-off schedule: 19 decimal digits (today's ufid shape)
 * from the SHA-256 of (`'ufid'`, queue, key), so a retried create lands on the same chain.
 */
export function deriveUfid(key: string, queue: string): string {
    const digest = createHash('sha256').update(['ufid', queue, key].join('\u0000')).digest();
    return (digest.readBigUInt64BE(0) % BigInt(10) ** BigInt(UFID_DIGITS)).toString().padStart(UFID_DIGITS, '0');
}

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

    /** Forgets the tracked meta task of `ufid`, under the current key and the v1.3.4 forms. */
    async delUfid(ufid: string, queueName?: string): Promise<void> {
        for (const key of [this.getCacheKeyForJob(ufid), ...this.legacyCacheKeysForJob(ufid, queueName)]) {
            await this.cacheManager.del(key);
        }
    }

    /**
     * The full resource name of the tracked meta task of `ufid`, or null when `ufid` is not a known
     * schedule. Reads `gcp_job:<ufid>`, then the v1.3.4 `gcp_job:<queue>:<ufid>` forms for the
     * request queue and the default queue (their value is a short task id in `meta-<queue>`).
     */
    async getIdFromUfid(ufid: string, queueName?: string): Promise<string | null> {
        const tracked = await this.cacheManager.get<string>(this.getCacheKeyForJob(ufid));
        if (tracked) {
            return tracked;
        }
        for (const queue of this.legacyQueues(queueName)) {
            const legacyId = await this.cacheManager.get<string>(this.legacyCacheKey(ufid, queue));
            if (legacyId) {
                return await this.getTaskPath(this.getMetaQueueName(queue), legacyId);
            }
        }
        return null;
    }

    /** Tracks `taskName` (in the meta queue of `queueName`) as the current meta task of `ufid`. */
    async setIdForUfid(ufid: string, taskName: string, queueName?: string): Promise<void> {
        const taskPath = await this.getTaskPath(this.getMetaQueueName(queueName), taskName);
        await this.cacheManager.set(this.getCacheKeyForJob(ufid), taskPath);
    }

    /** Marks `ufid` cancelled: its next meta delivery ends the chain without relaying. */
    async tombstone(ufid: string): Promise<void> {
        await this.cacheManager.set(this.getTombstoneKey(ufid), new Date().toISOString(), TOMBSTONE_TTL_MS);
    }

    async isTombstoned(ufid: string): Promise<boolean> {
        return !!(await this.cacheManager.get<string>(this.getTombstoneKey(ufid)));
    }

    /** One key form, independent of queue: the queue a schedule uses lives in its meta payload. */
    private getCacheKeyForJob(ufid: string): string {
        return `gcp_job:${ufid}`;
    }

    private getTombstoneKey(ufid: string): string {
        return `gcp_job:cancelled:${ufid}`;
    }

    /**
     * The queues whose v1.3.4 `gcp_job:<queue>:<ufid>` key may hold a tracked id: the request's, then
     * the default. A queue named `cancelled` is skipped: its old key is the tombstone's.
     */
    private legacyQueues(queueName?: string): string[] {
        return [...new Set([this.getQueueName(queueName), this.getQueueName()])].filter((queue) => queue !== 'cancelled');
    }

    private legacyCacheKey(ufid: string, queue: string): string {
        return `gcp_job:${queue}:${ufid}`;
    }

    private legacyCacheKeysForJob(ufid: string, queueName?: string): string[] {
        return this.legacyQueues(queueName).map((queue) => this.legacyCacheKey(ufid, queue));
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

            // Long-term one-time job OR any recurring job: create UFID and schedule a meta-job.
            // A caller key derives the ufid, so a retried create returns the same schedule.
            const keyed = !!request.idempotencyKey;
            const ufid = keyed ? deriveUfid(request.idempotencyKey!, this.getQueueName(request.queue)) : generateNumericId();
            if (keyed && await this.isTombstoned(ufid)) {
                this.logger.warn({ ufid }, 'keyed-schedule-cancelled: refusing a reused idempotency key');
                throw new ConflictException('A schedule with this idempotency key was cancelled; use a new key');
            }
            if (keyed) {
                // A tracked id means this key's schedule exists: a retry creates nothing (not even a
                // `create` task Cloud Tasks would accept again once its name's dedup window ended).
                const tracked = await this.cacheManager.get<string>(this.getCacheKeyForJob(ufid)).catch(() => null);
                if (tracked) {
                    this.logger.log({ ufid }, 'keyed-schedule-exists');
                    return { ufid, gcpTaskId: tracked.split('/').at(-1)! };
                }
            }
            this.logger.log(
                { ufid, keyed, recurring, scheduleTime: nextExecutionTime!.toISOString(), target: safeUrl(request.target) },
                'Scheduling meta-job',
            );

            // Named by ufid, so a retried create cannot start the chain twice (ALREADY_EXISTS returns
            // the same ufid). Later meta tasks are named by the occurrence they serve (MetaService).
            const gcpMetaTaskId = await this.createMetaEndpointTask(
                ufid,
                { ...request, isOccurrence: nextIsOccurrence, occurrence: realNextExecutionTime?.toISOString() },
                nextExecutionTime!,
                taskNameFor([ufid, 'create']),
            );
            if (!gcpMetaTaskId) {
                throw new Error(`[${ufid}] Failed to schedule meta-job task for ${safeUrl(request.target)}`);
            }

            // Best effort: the meta task exists, so failing now would only make the caller create a
            // second schedule. Cancel still stops a ufid it cannot find (tombstone by shape).
            try {
                await this.setIdForUfid(ufid, gcpMetaTaskId, request.queue);
            } catch (err: any) {
                this.logger.warn({ ufid, taskName: gcpMetaTaskId, error: err?.message ?? String(err) }, 'meta-tracked-id-write-failed');
            }
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

        const directTask = await this.getTaskPath(this.getQueueName(queueName), jobId);

        // Only a ufid-shaped id can be a schedule; any other id never reaches the cache.
        if (!UFID_SHAPE.test(jobId)) {
            return await this.deleteTaskByName(directTask, jobId);
        }

        // The tombstone is what stops a chain, so a ufid-shaped id is tombstoned even when no tracked
        // id is found (its write failed, or it lives under a v1.3.4 key of a third queue): cancel
        // then always ends the schedule, and cancelling twice answers true.
        const trackedTask = await this.getIdFromUfid(jobId, queueName);
        await this.tombstone(jobId);

        if (!trackedTask) {
            // It may also be a v1.3.4 direct task, whose auto id has the same shape.
            await this.deleteTaskByName(directTask, jobId);
            this.logger.log({ jobId }, 'schedule-cancelled: tombstone written (no tracked id)');
            return true;
        }

        // Deleting the tracked meta task only saves a delivery: best effort.
        await this.deleteTaskByName(trackedTask, jobId).catch((err) => {
            this.logger.warn({ jobId, taskName: trackedTask, code: err?.code, error: err?.message ?? String(err) }, 'cancel-tracked-meta-task-delete-failed');
        });
        try {
            await this.delUfid(jobId, queueName);
        } catch (err: any) {
            this.logger.warn({ jobId, error: err?.message ?? String(err) }, 'meta-tracked-id-delete-failed');
        }
        this.logger.log({ jobId }, 'schedule-cancelled: tombstone written');
        return true;
    }

    /** Deletes a task by full name: true if deleted, false on NOT_FOUND; other errors are thrown. */
    private async deleteTaskByName(name: string, jobId: string): Promise<boolean> {
        return await this.clientHolder.call('deleteTask', (c, o) => c.deleteTask({ name }, o)).then(() => true).catch((err) => {
            if (err?.code === 5) { // NOT_FOUND error code from GCP
                this.logger.warn(
                    { jobId, taskName: name },
                    'GCP task not found',
                );
                return false;
            }
            throw err;
        });
    }
}