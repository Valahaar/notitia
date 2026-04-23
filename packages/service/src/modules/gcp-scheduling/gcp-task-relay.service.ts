import { Injectable } from '@nestjs/common';
import { GcpTaskRelayPayloadDto } from './dto/gcp-task-relay-payload.dto';
import { HttpExecutorService } from '../../common/services/http-executor.service';

@Injectable()
export class GcpTaskRelayService {
    constructor(private readonly httpExecutor: HttpExecutorService) { }

    async executeTask(payload: GcpTaskRelayPayloadDto, taskId: string): Promise<void> {
        const { target, method, payload: requestPayload, headers, params, timeout } = payload;

        if (headers && !headers['X-Notitia-Task-ID']) {
            headers['X-Notitia-Task-ID'] = taskId;
        }

        const result = await this.httpExecutor.executeHttpRequest({
            taskId,
            target,
            method,
            payload: requestPayload,
            headers,
            params,
            timeoutSeconds: timeout,
        });

        if (!result.success) {
            // Re-throw the error for GCP to handle retries
            const error = new Error(result.error || 'HTTP request failed');
            if (result.status) {
                (error as any).status = result.status;
            }
            throw error;
        }
    }
}