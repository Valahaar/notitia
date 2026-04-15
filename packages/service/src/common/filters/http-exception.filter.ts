import { ExceptionFilter, Catch, ArgumentsHost, HttpException, Logger, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: HttpException, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const status = exception.getStatus();
        const exceptionResponse = exception.getResponse();

        // Ensure message is a string or a structured object, not an array of messages from class-validator
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
            // Include the request body if it's a BadRequest (often validation related)
            ...(status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0 && { body: request.body }),
        };

        const logMessage = `HTTP Exception: ${request.method} ${request.url} - Status: ${status} - Error: ${JSON.stringify(messageDetail)}`;

        if (status === HttpStatus.BAD_REQUEST && request.body && Object.keys(request.body).length > 0) {
            this.logger.error(
                `${logMessage} - Request Body: ${JSON.stringify(request.body)}`,
                exception.stack,
            );
        } else {
            this.logger.error(
                logMessage,
                exception.stack,
            );
        }

        // Prevent sending an array of messages directly, use the structured errorResponse
        response.status(status).json(errorResponse);
    }
}