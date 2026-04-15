import { Module } from '@nestjs/common';
import { InMemorySchedulerService } from './in-memory.scheduler.service';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { HttpExecutorService } from '../../common/services/http-executor.service';

@Module({
    providers: [
        InMemorySchedulerService,
        ScheduleHelperService,
        HttpExecutorService,
    ],
    exports: [InMemorySchedulerService],
})
export class InMemorySchedulingModule { }