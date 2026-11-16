import { Injectable, Logger, Inject } from '@nestjs/common';
import { OneTimeScheduleDto, RecurringScheduleDto, ScheduleType } from '../../common/dto/schedule-request.dto';
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
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid, queue), { ufid }, 'meta-tracked-id-delete-failed');
            return;
        }

        const T = this.occurrenceOf(payload, delivery, now);
        if (!T) {
            this.logger.log({ ufid }, 'meta-chain-ended: rule has no further occurrence');
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid, queue), { ufid }, 'meta-tracked-id-delete-failed');
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
        const successor = this.successorOf(payload, T, now);
        if (!successor) {
            this.logger.log({ ufid, occurrence }, 'meta-chain-ended: rule has no further occurrence');
            await this.bestEffort(() => this.gcpTaskScheduler.delUfid(ufid, queue), { ufid }, 'meta-tracked-id-delete-failed');
            return;
        }
        const next = await this.scheduleMetaFor(ufid, payload, successor, delivery, now);

        // 5. Best effort: the tracked id only serves eager delete on cancel.
        await this.track(ufid, next, queue);
    }

    /** Replaced by the real tombstone lookup (cancel by tombstone). Until then nothing is tombstoned. */
    protected async isTombstoned(_ufid: string): Promise<boolean> {
        return false;
    }

    /**
     * The occurrence T this delivery serves: the payload's `occurrence`; for a v1.3.4 payload
     * (no `occurrence`), the one-off's time, the next occurrence after now for an intermediate
     * recurring hop, else the delivering task's ETA. Null when a legacy recurring hop has no next
     * occurrence.
     */
    private occurrenceOf(payload: GcpMetaTaskPayload, delivery: MetaDelivery, now: Date): Date | null {
        if (payload.occurrence) {
            const t = new Date(payload.occurrence);
            if (!Number.isNaN(t.getTime())) {
                return t;
            }
            this.logger.warn({ occurrence: payload.occurrence }, 'meta-payload-occurrence-invalid');
        }
        if (payload.schedule?.type === ScheduleType.ON) {
            return new Date((payload.schedule as OneTimeScheduleDto).time);
        }
        if (payload.schedule?.type === ScheduleType.RECURRING && payload.isOccurrence === false) {
            // A v1.3.4 hop fired at its 30-day horizon, not at T: its ETA is not the occurrence.
            const recurring = payload.schedule as RecurringScheduleDto;
            return this.scheduleHelper.calculateNextOccurrence(recurring.schedule, now, { timezone: recurring.timezone });
        }
        if (delivery.etaSeconds !== undefined && Number.isFinite(delivery.etaSeconds)) {
            return new Date(delivery.etaSeconds * 1000);
        }
        this.logger.warn({ deliveringTask: delivery.taskName }, 'meta-occurrence-unknown: using now');
        return now;
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

    /** `S = after(T)`; if that is already past (a late delivery), skip ahead to `after(now)`. */
    private successorOf(payload: GcpMetaTaskPayload, T: Date, now: Date): Date | null {
        if (payload.schedule?.type !== ScheduleType.RECURRING) {
            return null;
        }
        const recurring = payload.schedule as RecurringScheduleDto;
        const options = { timezone: recurring.timezone };
        const afterT = this.scheduleHelper.calculateNextOccurrence(recurring.schedule, T, options);
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
