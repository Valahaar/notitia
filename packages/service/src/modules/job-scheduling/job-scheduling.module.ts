import { Module } from '@nestjs/common';
import { JobSchedulingController } from './job-scheduling.controller';
import { JobSchedulingService } from './job-scheduling.service';
import { GcpSchedulingModule } from '../gcp-scheduling/gcp-scheduling.module';
import { GcpTaskSchedulerService } from '../gcp-scheduling/gcp-task.scheduler.service';
import { InMemorySchedulingModule } from '../in-memory-scheduling/in-memory-scheduling.module';
import { InMemorySchedulerService } from '../in-memory-scheduling/in-memory.scheduler.service';
import { JOB_SCHEDULER_TOKEN } from '../../common/constants';
import { IJobScheduler } from '../../common/interfaces/job-scheduler.interface';

// Helper function to determine which modules and providers to load
const createJobSchedulingModule = () => {
    const schedulerType = process.env.SCHEDULER_TYPE || 'gcp';

    const baseImports: Parameters<typeof Module>[0]['imports'] = [];
    const providers: Parameters<typeof Module>[0]['providers'] = [JobSchedulingService];

    if (schedulerType === 'in-memory') {
        baseImports.push(InMemorySchedulingModule);
        providers.push({
            provide: JOB_SCHEDULER_TOKEN,
            useFactory: (inMemoryScheduler: InMemorySchedulerService): IJobScheduler => {
                return inMemoryScheduler;
            },
            inject: [InMemorySchedulerService],
        });
    } else if (schedulerType === 'gcp') {
        baseImports.push(GcpSchedulingModule);
        providers.push({
            provide: JOB_SCHEDULER_TOKEN,
            useFactory: (gcpScheduler: GcpTaskSchedulerService): IJobScheduler => {
                return gcpScheduler;
            },
            inject: [GcpTaskSchedulerService],
        });
    } else {
        throw new Error(`Invalid scheduler type: ${schedulerType}. Must be 'in-memory' or 'gcp'.`);
    }

    return {
        imports: baseImports,
        controllers: [JobSchedulingController],
        providers,
    };
};

const moduleConfig = createJobSchedulingModule();

@Module(moduleConfig)
export class JobSchedulingModule { }