import { Module } from '@nestjs/common';
import { GcpTaskSchedulerService } from './gcp-task.scheduler.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleHelperService } from '../../common/services/schedule.helper.service';
import { HttpExecutorService } from '../../common/services/http-executor.service';
import { GcpTaskRelayController } from './gcp-task-relay.controller';
import { GcpTaskRelayService } from './gcp-task-relay.service';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
    imports: [
        ConfigModule,
    ],
    controllers: [MetaController, GcpTaskRelayController],
    providers: [
        GcpTaskSchedulerService,
        MetaService,
        ScheduleHelperService,
        HttpExecutorService,
        GcpTaskRelayService,
        AuthGuard,
    ],
    exports: [GcpTaskSchedulerService],
})
export class GcpSchedulingModule { }