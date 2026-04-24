import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { logError } from '../logger/helpers';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: HttpException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const status = exception.getStatus();
        const exceptionResponse = exception.getResponse();

        let messageDetail: any = 'Internal server error';
        if (typeof exceptionResponse === 'string') {
            messageDetail = exceptionResponse;
        } else if (exceptionResponse && typeof exceptionResponse === 'object') {
            messageDetail = (exceptionResponse as any).message || exception.message;
        } else {
            messageDetail = exception.message;
        }

        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            method: request.method,
            message: messageDetail,
            ...(status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0 && { body: request.body }),
        };

        logError(this.logger, exception, {
            status,
            path: request.url,
            method: request.method,
            detail: messageDetail,
            ...(status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0
                ? { requestBody: request.body }
                : {}),
        });

        response.status(status).json(errorResponse);
    }
}
