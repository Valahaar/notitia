import { Controller, Post, Body, Param, HttpCode, HttpStatus, Logger, InternalServerErrorException, HttpException, Headers, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetaService } from './meta.service';
import { ScheduleRequestDto } from '../../common/dto/schedule-request.dto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { safeUrl } from '../../common/utils/log.util';

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
    @ApiResponse({ status: 400, description: 'Bad Request - e.g., UFID not found in cache or malformed payload.' })
    @ApiResponse({ status: 500, description: 'Internal server error during meta-task processing.' })
    async processMetaJob(
        @Param('id') ufid: string,
        @Headers() headers: Record<string, string>,
        @Body() originalRequest: ScheduleRequestDto & { isOccurrence: boolean } // GCP task for meta-job will POST the original ScheduleRequestDto as its body
    ): Promise<void> {

        const taskName = headers['x-cloudtasks-taskname'] || 'unknown';
        const retryCount = headers['x-cloudtasks-taskretrycount'] || '0';

        this.logger.log(
            { ufid, taskName, retry: retryCount, target: safeUrl(originalRequest.target) },
            'Received meta-job',
        );
        try {
            await this.metaService.processMetaJob(ufid, originalRequest, originalRequest.queue);
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