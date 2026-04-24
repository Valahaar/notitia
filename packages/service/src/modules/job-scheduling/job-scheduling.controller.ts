import { Controller, Post, Body, HttpCode, HttpStatus, Delete, Param, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { JobSchedulingService } from './job-scheduling.service';
import { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto } from '../../common/dto/schedule-request.dto';
import { ScheduleJobResponseDto } from '../../common/dto/schedule-job-response.dto';
import { safeUrl } from '../../common/utils/log.util';
import { logAudit } from '../../common/logger/helpers';

@ApiTags('Job Scheduling')
@Controller()
export class JobSchedulingController {
    private readonly logger = new Logger(JobSchedulingController.name);

    constructor(private readonly jobSchedulingService: JobSchedulingService) { }

    @Post('schedule')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Submit an HTTP call for immediate, scheduled, or recurring execution.' })
    @ApiBody({
        description: 'HTTP call scheduling request',
        type: ScheduleRequestDto,
        examples: {
            oneTime: {
                summary: 'One-time scheduled HTTP call',
                value: {
                    schedule: {
                        type: 'on',
                        time: new Date(Date.now() + 3600 * 1000).toISOString(), // e.g., 1 hour from now
                    } as OneTimeScheduleDto,
                    target: 'https://my-service.com/webhook/user-created',
                    payload: { userId: 123, email: 'test@example.com' },
                },
            },
            recurring: {
                summary: 'Recurring HTTP call (e.g., every day at midnight)',
                value: {
                    schedule: {
                        type: 'recurring',
                        schedule: '0 0 * * *', // Cron for every day at midnight
                    } as RecurringScheduleDto,
                    target: 'https://my-service.com/webhook/nightly-cleanup',
                },
            },
            immediate: {
                summary: 'Immediate HTTP call',
                value: {
                    target: 'https://my-service.com/webhook/immediate-action',
                    payload: { data: 'some_data' },
                    // No schedule for immediate, jobId is optional
                },
            }
        },
    })
    @ApiResponse({ status: 202, description: 'Request accepted for processing and job ID returned.', type: ScheduleJobResponseDto })
    @ApiResponse({ status: 400, description: 'Invalid request body.' })
    @ApiResponse({ status: 500, description: 'Internal server error.' })
    async scheduleJob(@Body() scheduleRequestDto: ScheduleRequestDto): Promise<ScheduleJobResponseDto> {
        const jobId = await this.jobSchedulingService.scheduleJobProcessing(scheduleRequestDto);
        logAudit(this.logger, 'job.scheduled', {
            jobId,
            target: safeUrl(scheduleRequestDto.target),
            method: scheduleRequestDto.method || 'POST',
            schedule: scheduleRequestDto.schedule?.type || 'immediate',
        });
        return { jobId };
    }

    @Delete('schedule/:id')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Cancel a scheduled HTTP call.' })
    @ApiParam({ name: 'id', description: 'The ID of the job to cancel (UFID or direct GCP task ID)', type: String })
    @ApiResponse({ status: 200, description: 'Cancellation request processed. Returns true if cancellation was attempted, false otherwise.', type: Boolean })
    @ApiResponse({ status: 400, description: 'Invalid request (e.g., malformed ID).' })
    @ApiResponse({ status: 404, description: 'Job not found or already processed/cancelled.' })
    @ApiResponse({ status: 500, description: 'Internal server error during cancellation.' })
    async cancelScheduledJob(@Param('id') jobId: string, @Query('queue') queue?: string): Promise<boolean> {
        const result = await this.jobSchedulingService.cancelScheduledJobProcessing(jobId, queue);
        logAudit(this.logger, 'job.cancelled', {
            jobId,
            queue: queue || 'default',
            result: result ? 'cancelled' : 'not_found',
        });
        return result;
    }
}