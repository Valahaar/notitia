import { Injectable, Logger, Inject, InternalServerErrorException } from '@nestjs/common';
import { ScheduleRequestDto } from '../../common/dto/schedule-request.dto';
import { GcpTaskSchedulerService } from './gcp-task.scheduler.service';
import { safeUrl } from '../../common/utils/log.util';


@Injectable()
export class MetaService {
    private readonly logger = new Logger(MetaService.name);

    constructor(
        @Inject(GcpTaskSchedulerService) private readonly gcpTaskScheduler: GcpTaskSchedulerService,
    ) { }

    async processMetaJob(ufid: string, originalRequest: ScheduleRequestDto & { isOccurrence: boolean }, queueName?: string): Promise<void> {
        this.logger.log(`[${ufid}] Processing meta-job (isOccurrence: ${originalRequest.isOccurrence}) -> ${safeUrl(originalRequest.target)}`);
        const queue = this.gcpTaskScheduler.getQueueName(queueName ?? originalRequest.queue);

        const cachedGcpTaskId = await this.gcpTaskScheduler.getIdFromUfid(ufid, queueName);
        if (!cachedGcpTaskId) {
            this.logger.warn(`[${ufid}] UFID not found in cache (queue: ${queue}), meta-job might be stale`);
            return;
        }

        const { nextExecutionTime, recurring, nextIsOccurrence } = this.gcpTaskScheduler.computeNextExecutionTime(originalRequest);
        const { schedule, ...executionPayload } = originalRequest;

        if (recurring) {
            if (originalRequest.isOccurrence) {
                // running occurrence of recurrence immediately, then see if we need to re-schedule
                // Add the UFID to headers so the relay service can use it as the task ID
                const executionPayloadWithTaskId = {
                    ...executionPayload,
                    headers: {
                        ...(executionPayload.headers || {}),
                        'X-Notitia-Task-ID': ufid,
                    },
                };
                await this.gcpTaskScheduler.createRelayEndpointTask(executionPayloadWithTaskId);
            }

            if (nextExecutionTime) {
                // running recurrence, so we need to re-schedule the meta-job
                const newMetaGcpTaskId = await this.gcpTaskScheduler.createMetaEndpointTask(ufid, { ...originalRequest, isOccurrence: nextIsOccurrence }, nextExecutionTime!);
                if (!newMetaGcpTaskId) {
                    this.logger.error(`[${queue}:${ufid}] Failed to re-schedule meta-job. UFID cache not updated.`);
                    throw new InternalServerErrorException(`[${ufid}] Failed to re-schedule meta-job.`);
                } else {
                    await this.gcpTaskScheduler.setIdForUfid(ufid, newMetaGcpTaskId);
                    this.logger.log(`[${ufid}] Re-scheduled recurring meta-job. GCP Task ID: ${newMetaGcpTaskId}`);
                }
            } else {
                this.logger.log(`[${ufid}] Recurring job complete, clearing cache`);
                await this.gcpTaskScheduler.delUfid(ufid);
            }

            return;
        }

        if (nextIsOccurrence) {
            // we're hitting the end of the long-running job, so we need to schedule the actual relayed task
            // this time we're within the 30 days, so it'll be scheduled to the actual delivery date
            // Add the UFID to headers so the relay service can use it as the task ID
            const requestWithTaskId = {
                ...originalRequest,
                headers: {
                    ...(originalRequest.headers || {}),
                    'X-Notitia-Task-ID': ufid,
                },
            };
            const newTaskId = await this.gcpTaskScheduler.createRelayEndpointTask(requestWithTaskId, nextExecutionTime);
            if (newTaskId) {
                await this.gcpTaskScheduler.setIdForUfid(ufid, newTaskId);
                this.logger.log(`[${ufid}] Scheduled actual relayed task. New GCP task ID: ${newTaskId}`);
            } else {
                this.logger.error(`[${ufid}] Failed to schedule actual relayed task. UFID cache not updated.`);
                throw new InternalServerErrorException(`[${ufid}] Failed to schedule actual relayed task.`);
            }
        } else {
            // if the next execution time is different from the real next execution time, we need to re-schedule the meta-job
            const newMetaGcpTaskId = await this.gcpTaskScheduler.createMetaEndpointTask(ufid, { ...originalRequest, isOccurrence: nextIsOccurrence }, nextExecutionTime!);
            if (newMetaGcpTaskId) {
                await this.gcpTaskScheduler.setIdForUfid(ufid, newMetaGcpTaskId);
                this.logger.log(`[${ufid}] Re-scheduled meta-job. New GCP meta task ID: ${newMetaGcpTaskId}`);
            } else {
                this.logger.error(`[${ufid}] Failed to re-schedule meta-job. UFID cache not updated.`);
                throw new InternalServerErrorException(`[${ufid}] Failed to re-schedule meta-job.`);
            }
        }
    }
}