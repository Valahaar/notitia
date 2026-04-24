import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JobSchedulingModule } from './modules/job-scheduling/job-scheduling.module';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import KeyvRedis from '@keyv/redis';
import KeyvMongo from '@keyv/mongo';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TraceContextMiddleware } from './common/middleware/trace-context.middleware';
import { HealthController } from './common/controllers/health.controller';
import { LoggerModule } from './common/logger/logger.module';

const throttleTtl = Number(process.env.THROTTLE_TTL);
const throttleLimit = Number(process.env.THROTTLE_LIMIT);
const throttleEnabled = throttleTtl > 0 && throttleLimit > 0;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const required = ['AUTH_TOKEN'];
        const missing = required.filter((key) => !config[key]);
        if (missing.length > 0) {
          throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }
        return config;
      },
    }),
    LoggerModule,
    ...(throttleEnabled
      ? [ThrottlerModule.forRoot({ throttlers: [{ ttl: throttleTtl, limit: throttleLimit }] })]
      : []),
    CacheModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const storeType = configService.get<string>('CACHE_STORE', 'redis');

        let store;
        if (storeType === 'mongo') {
          const mongoUrl = configService.get<string>('MONGO_URL', 'mongodb://localhost:27017');
          const mongoDb = configService.get<string>('MONGO_DB', 'notitia');
          store = new KeyvMongo(mongoUrl, { db: mongoDb, collection: 'cache' });
        } else {
          const host = configService.get<string>('REDIS_HOST', 'localhost');
          const port = configService.get<number>('REDIS_PORT', 6379);
          store = new KeyvRedis(`redis://${host}:${port}`);
        }

        return { stores: [store] };
      },
      inject: [ConfigService],
      isGlobal: true,
    }),
    JobSchedulingModule,
  ],
  controllers: [HealthController],
  providers: [
    ...(throttleEnabled ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, TraceContextMiddleware)
      .forRoutes('*');
  }
}
