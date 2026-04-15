import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto } from './common/dto/schedule-request.dto';
import { ScheduleJobResponseDto } from './common/dto/schedule-job-response.dto';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import helmet from 'helmet';
import { json } from 'express';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    app.use(helmet());
    app.use(json({ limit: '1mb' }));

    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    }));

    app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

    const config = new DocumentBuilder()
        .setTitle('Notitia API')
        .setDescription(
            'API for emitting events immediately, scheduled, or recurring. '
        )
        .setVersion('1.0')
        .build();

    const document = SwaggerModule.createDocument(app, config, {
        extraModels: [ScheduleRequestDto, OneTimeScheduleDto, RecurringScheduleDto, ScheduleJobResponseDto]
    });
    SwaggerModule.setup('docs', app, document);

    const port = process.env.PORT || 3000;
    await app.listen(port);
}
bootstrap();
