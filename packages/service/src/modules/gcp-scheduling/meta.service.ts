import { Injectable, Logger, Inject } from '@nestjs/common';
import { RecurringScheduleDto, ScheduleType } from '../../common/dto/schedule-request.dto';
import { GcpTaskSchedulerService, GCP_MAX_SCHEDULE_SECONDS } from './gcp-task.scheduler.service';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { GcpMetaTaskPayload } from './dto/gcp-meta-task-payload.dto';
import { taskNameFor } from './task-name';
import { safeUrl } from '../../common/utils/log.util';
import { NOTITIA_TASK_ID_HEADER } from '../../common/constants';

/** The Cloud Tasks delivery being processed, from its `X-CloudTasks-*` headers. */
export interface MetaDelivery {
    /** Short name of the delivering task (`X-CloudTasks-TaskName`). */
    taskName: string;
    /** Its schedule time in epoch seconds (`X-CloudTasks-TaskETA`), when known. */
    etaSeconds?: number;
}

const MAX_HORIZON_MS = GCP_MAX_SCHEDULE_SECONDS * 1000;

/**
 * Processes one delivery of a meta task (recurring schedules and one-offs beyond 30 days).
 *
 * Every task the chain creates is named by the occurrence it serves, so replays, retries and
 * late deliveries re-create the same names (ALREADY_EXISTS = already done) and a chain that ever
 * splits merges again at the next occurrence both halves compute:
 * - meta task that fires at occurrence T: `taskNameFor([ufid, 'meta', T])`
 * - relay for occurrence T: `taskNameFor([ufid, 'relay', T])`
 * - intermediate 30-day hop towards T: `taskNameFor([ufid, 'hop', T, deliveringTaskName])`
 */
@Injectable()
export class MetaService {
    private readonly logger = new Logger(MetaService.name);

    constructor(
        @Inject(GcpTaskSchedulerService) private readonly gcpTaskScheduler: GcpTaskSchedulerService,
        @Inject(ScheduleHelperService) private readonly scheduleHelper: ScheduleHelperService,
    ) { }

    async processMetaJob(ufid: string, payload: GcpMetaTaskPayload, delivery: MetaDelivery): Promise<void> {
        const now = new Date();
        const queue = payload.queue;

        // 1. The tombstone is the only stop signal; a missing tracked id is not.
        if (await this.isTombstoned(ufid)) {
            this.logger.log({ ufid, deliveringTask: delivery.taskName }, 'meta-chain-cancelled');
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid), { ufid }, 'meta-tracked-id-delete-failed');
            return;
        }

        const T = this.occurrenceOf(payload);
        if (!T) {
            this.logger.error({ ufid, deliveringTask: delivery.taskName }, 'meta-chain-dropped: payload has no valid occurrence');
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid), { ufid }, 'meta-tracked-id-delete-failed');
            return;
        }
        const occurrence = T.toISOString();
        this.logger.log(
            { ufid, occurrence, deliveringTask: delivery.taskName, target: safeUrl(payload.target) },
            'Processing meta-job',
        );

        // 2. Not yet due (an intermediate hop): move one hop closer to T, or onto T itself.
        if (!this.isDue(ufid, T, delivery, now)) {
            const next = await this.scheduleMetaFor(ufid, payload, T, delivery, now);
            await this.track(ufid, next, queue);
            return;
        }

        // 3. Relay occurrence T, now. Its name makes a replay of this delivery a no-op.
        const { schedule: _schedule, isOccurrence: _isOccurrence, occurrence: _occurrence, ...execution } = payload;
        const relayRequest = this.gcpTaskScheduler.withOccurrenceHeader(
            { ...execution, headers: { ...(execution.headers || {}), [NOTITIA_TASK_ID_HEADER]: ufid } },
            T,
        );
        const relayTaskName = taskNameFor([ufid, 'relay', occurrence]);
        await this.gcpTaskScheduler.createRelayEndpointTask(relayRequest, undefined, relayTaskName);
        this.logger.log({ ufid, occurrence, gcpTaskId: relayTaskName }, 'Relayed occurrence');

        // 4. The successor, unless the rule has ended (one-offs have none).
        const successor = this.successorOf(ufid, payload, T, now);
        if (!successor) {
            this.logger.log({ ufid, occurrence }, 'meta-chain-ended: rule has no further occurrence');
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid), { ufid }, 'meta-tracked-id-delete-failed');
            return;
        }
        const next = await this.scheduleMetaFor(ufid, payload, successor, delivery, now);

        // 5. Best effort: the tracked id only serves eager delete on cancel.
        await this.track(ufid, next, queue);
    }

    /**
     * Whether the schedule was cancelled. A failed lookup counts as not cancelled: a cancel then takes
     * effect at the next delivery whose lookup succeeds, whereas failing the delivery could exhaust
     * the meta queue's retries and silently end a live schedule.
     */
    private async isTombstoned(ufid: string): Promise<boolean> {
        try {
            return await this.gcpTaskScheduler.isTombstoned(ufid);
        } catch (error: any) {
            this.logger.warn({ ufid, error: error?.message ?? String(error) }, 'meta-tombstone-lookup-failed');
            return false;
        }
    }

    /** The occurrence T this delivery serves: the payload's `occurrence`, or null when it is missing or invalid. */
    private occurrenceOf(payload: GcpMetaTaskPayload): Date | null {
        if (!payload.occurrence) {
            return null;
        }
        const t = new Date(payload.occurrence);
        return Number.isNaN(t.getTime()) ? null : t;
    }

    /**
     * A delivery serves T now if T has passed, if the delivering task was scheduled for T (our
     * clock may trail Cloud Tasks' slightly), or if it is the meta task for T itself: re-creating
     * that one would answer ALREADY_EXISTS and silently end the chain.
     */
    private isDue(ufid: string, T: Date, delivery: MetaDelivery, now: Date): boolean {
        if (T.getTime() <= now.getTime()) {
            return true;
        }
        if (delivery.etaSeconds !== undefined && delivery.etaSeconds * 1000 >= T.getTime() - 1000) {
            return true;
        }
        return delivery.taskName === taskNameFor([ufid, 'meta', T.toISOString()]);
    }

    /**
     * `S = after(T)`; if that is already past (a late delivery), skip ahead to `after(now)`. A rule
     * evaluation that answers `S <= T` would re-create T's own meta task (ALREADY_EXISTS) and
     * silently end the chain, so it also falls back to `after(now)`.
     */
    private successorOf(ufid: string, payload: GcpMetaTaskPayload, T: Date, now: Date): Date | null {
        if (payload.schedule?.type !== ScheduleType.RECURRING) {
            return null;
        }
        const recurring = payload.schedule as RecurringScheduleDto;
        const options = { timezone: recurring.timezone };
        const afterT = this.scheduleHelper.calculateNextOccurrence(recurring.schedule, T, options);
        if (afterT && afterT.getTime() <= T.getTime()) {
            this.logger.warn({ ufid, occurrence: T.toISOString(), successor: afterT.toISOString() }, 'meta-successor-not-after-occurrence');
            return this.scheduleHelper.calculateNextOccurrence(recurring.schedule, now, options);
        }
        if (afterT && afterT.getTime() < now.getTime()) {
            return this.scheduleHelper.calculateNextOccurrence(recurring.schedule, now, options);
        }
        return afterT;
    }

    /**
     * Creates the meta task serving occurrence `at`: the final one, firing at `at`, when it is
     * within the 30-day horizon; otherwise a hop at the horizon. Returns the task name.
     */
    private async scheduleMetaFor(ufid: string, payload: GcpMetaTaskPayload, at: Date, delivery: MetaDelivery, now: Date): Promise<string> {
        const horizon = new Date(now.getTime() + MAX_HORIZON_MS);
        const final = at.getTime() <= horizon.getTime();
        const occurrence = at.toISOString();
        const name = final
            ? taskNameFor([ufid, 'meta', occurrence])
            : taskNameFor([ufid, 'hop', occurrence, delivery.taskName]);
        const { isOccurrence: _isOccurrence, occurrence: _occurrence, ...request } = payload;
        await this.gcpTaskScheduler.createMetaEndpointTask(
            ufid,
            { ...request, isOccurrence: final, occurrence },
            final ? at : horizon,
            name,
        );
        this.logger.log({ ufid, occurrence, gcpTaskId: name, hop: !final }, 'Scheduled meta-job');
        return name;
    }

    private async track(ufid: string, taskName: string, queue: string | undefined): Promise<void> {
        await this.bestEffort(() => this.gcpTaskScheduler.setIdForUfid(ufid, taskName, queue), { ufid, taskName }, 'meta-tracked-id-write-failed');
    }

    private async bestEffort(op: () => Promise<unknown>, context: Record<string, unknown>, event: string): Promise<void> {
        try {
            await op();
        } catch (error: any) {
            this.logger.warn({ ...context, error: error?.message ?? String(error) }, event);
        }
    }
}
