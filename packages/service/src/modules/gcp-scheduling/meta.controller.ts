import { Controller, Post, Body, Param, HttpCode, HttpStatus, Logger, InternalServerErrorException, HttpException, Headers, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetaService } from './meta.service';
import { GcpMetaTaskPayload } from './dto/gcp-meta-task-payload.dto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { safeUrl } from '../../common/utils/log.util';
import { randomUUID } from 'crypto';

@ApiExcludeController()
@Controller('meta')
@UseGuards(AuthGuard)
export class MetaController {
    private readonly logger = new Logger(MetaController.name);

    constructor(private readonly metaService: MetaService) { }

    @Post(':id')
    @HttpCode(HttpStatus.OK) // GCP expects 2xx for success
    @ApiOperation({
        summary: 'Internal endpoint for GCP Cloud Tasks to process meta-jobs.',
        description: 'This endpoint receives meta-tasks from GCP Cloud Tasks. It should not be called directly by users.'
    })
    @ApiResponse({ status: 200, description: 'Meta-task received and processed (or re-queued).' })
    @ApiResponse({ status: 400, description: 'Bad Request - e.g., malformed payload.' })
    @ApiResponse({ status: 500, description: 'Internal server error during meta-task processing.' })
    async processMetaJob(
        @Param('id') ufid: string,
        @Headers() headers: Record<string, string>,
        @Body() originalRequest: GcpMetaTaskPayload // GCP task for meta-job will POST the original ScheduleRequestDto (plus occurrence) as its body
    ): Promise<void> {

        // Cloud Tasks always sends both. A missing name gets a fresh one so a hop name derived
        // from it can never collide with the task being delivered.
        const taskName = headers['x-cloudtasks-taskname'] || `unknown-${randomUUID()}`;
        const eta = Number.parseFloat(headers['x-cloudtasks-tasketa'] ?? '');
        const retryCount = headers['x-cloudtasks-taskretrycount'] || '0';

        this.logger.log(
            { ufid, taskName, eta: headers['x-cloudtasks-tasketa'], retry: retryCount, target: safeUrl(originalRequest.target) },
            'Received meta-job',
        );
        try {
            await this.metaService.processMetaJob(ufid, originalRequest, {
                taskName,
                etaSeconds: Number.isFinite(eta) ? eta : undefined,
            });
        } catch (error) {
            this.logger.error(
                `[${ufid}] Error processing meta-job for original target ${safeUrl(originalRequest.target)}:`,
                error,
            );
            // For GCP, any non-2xx response typically means retry (unless queue is configured otherwise)
            // We can throw specific errors if MetaService provides them, or a generic one.
            if (error instanceof HttpException) { // HttpException is not imported, should be.
                throw error;
            }
            throw new InternalServerErrorException(`[${ufid}] Failed to process meta-job`);
        }
    }
}