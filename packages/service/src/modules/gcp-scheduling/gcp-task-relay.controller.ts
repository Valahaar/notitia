import { Controller, Post, Body, HttpCode, HttpStatus, Logger, HttpException, Headers, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiBody, ApiResponse, ApiExcludeController } from '@nestjs/swagger';
import { GcpTaskRelayService } from './gcp-task-relay.service';
import { GcpTaskRelayPayloadDto } from './dto/gcp-task-relay-payload.dto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { safeUrl } from '../../common/utils/log.util';

export const GCP_RELAY_PATH = 'relay';

@ApiExcludeController()
@Controller(GCP_RELAY_PATH)
@UseGuards(AuthGuard)
export class GcpTaskRelayController {
    private readonly logger = new Logger(GcpTaskRelayController.name);

    constructor(private readonly gcpTaskRelayService: GcpTaskRelayService) { }

    @Post()
    @HttpCode(HttpStatus.OK) // GCP expects 2xx for success, non-2xx for retry (unless configured otherwise)
    @ApiOperation({
        summary: 'Internal endpoint for GCP Cloud Tasks to relay HTTP calls.',
        description: 'This endpoint receives tasks from GCP Cloud Tasks and forwards them to their original target URL. It should not be called directly by users.'
    })
    @ApiBody({ type: GcpTaskRelayPayloadDto })
    @ApiResponse({ status: 200, description: 'Task received and attempt to relay was made. Check logs for actual relay status.' })
    @ApiResponse({ status: 500, description: 'Internal server error during relay attempt.' })
    @ApiResponse({ status: 502, description: 'Bad Gateway - Error from the upstream service (original target).' })
    async handleGcpTask(
        @Body() payload: GcpTaskRelayPayloadDto,
        @Headers() headers: Record<string, string>,
    ): Promise<void> {

        const taskName = headers['x-cloudtasks-taskname'] || 'unknown';
        const retryCount = headers['x-cloudtasks-taskretrycount'] || '0';

        // Task ID comes from headers if it's a meta-job-generated task, otherwise use GCP task name
        const taskId = payload.headers?.['X-Notitia-Task-ID'] || taskName;

        this.logger.log(
            { taskId, taskName, retry: retryCount, target: safeUrl(payload.target) },
            'Received GCP task',
        );
        try {
            await this.gcpTaskRelayService.executeTask(payload, taskId);
            // If executeTask completes without error, it means the attempt was made.
            // If executeTask itself threw an error (e.g. AxiosError), we catch it below.
        } catch (error) {
            const status = (error as any).status || HttpStatus.INTERNAL_SERVER_ERROR;
            const message = error instanceof Error ? error.message : String(error);

            this.logger.error(
                { taskId, error: message },
                'Relay failed',
            );

            throw new HttpException(
                message || 'Error relaying to original target',
                status,
            );
        }
    }
}