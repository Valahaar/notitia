import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import helmet from 'helmet';
import { json } from 'express';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.useLogger(app.get(Logger));

    app.use(helmet());
    app.use(json({ limit: '1mb' }));

    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }));

    app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

    // Swagger is mounted lazily on first hit to /docs. createDocument()
    // walks every controller + DTO via reflect-metadata, which is one of the
    // heaviest bootstrap steps. Deferring it removes that cost from cold
    // start; the first /docs request pays it once, then it's cached.
    setupLazySwagger(app);

    const port = process.env.PORT || 3000;
    await app.listen(port);
}

function setupLazySwagger(app: Awaited<ReturnType<typeof NestFactory.create>>): void {
    const expressApp = app.getHttpAdapter().getInstance();
    let swaggerReady: Promise<void> | null = null;

    const ensureSwagger = (): Promise<void> => {
        if (!swaggerReady) {
            swaggerReady = (async () => {
                const [
                    { DocumentBuilder, SwaggerModule },
                    { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto },
                    { ScheduleJobResponseDto },
                ] = await Promise.all([
                    import('@nestjs/swagger'),
                    import('./common/dto/schedule-request.dto'),
                    import('./common/dto/schedule-job-response.dto'),
                ]);

                const config = new DocumentBuilder()
                    .setTitle('Notitia API')
                    .setDescription('API for emitting events immediately, scheduled, or recurring.')
                    .setVersion('1.0')
                    .build();

                const document = SwaggerModule.createDocument(app, config, {
                    extraModels: [
                        ScheduleRequestDto,
                        OneTimeScheduleDto,
                        RecurringScheduleDto,
                        ScheduleJobResponseDto,
                    ],
                });
                SwaggerModule.setup('docs', app, document);
            })();
        }
        return swaggerReady;
    };

    expressApp.use('/docs', (_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
        ensureSwagger().then(() => next(), (err) => next(err));
    });
}

bootstrap();
