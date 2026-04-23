import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig, Method } from 'axios';
import { HttpMethod } from '../dto/schedule-request.dto';
import { safeUrl } from '../utils/log.util';

export interface HttpExecutionRequest {
    taskId: string;
    target: string;
    method?: HttpMethod;
    payload?: Record<string, any>;
    headers?: Record<string, string>;
    params?: Record<string, any>;
    timeoutSeconds?: number;
}

export interface HttpExecutionResult {
    success: boolean;
    status?: number;
    error?: string;
    duration: number;
}

@Injectable()
export class HttpExecutorService {
    private readonly logger = new Logger(HttpExecutorService.name);
    private readonly defaultTimeoutMs: number;

    constructor(configService: ConfigService) {
        const rawTimeout = Number(configService.get<string>('DEFAULT_TIMEOUT_SECONDS'));
        this.defaultTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 15 && rawTimeout <= 1800
            ? Math.floor(rawTimeout) * 1000
            : 1000 * 60 * 10; // 10 minutes - same as Cloud Tasks default (600s)
    }

    async executeHttpRequest(request: HttpExecutionRequest): Promise<HttpExecutionResult> {
        const { taskId, target, method = HttpMethod.POST, payload, headers = {}, params, timeoutSeconds } = request;
        const startTime = Date.now();
        const timeoutMs = timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : this.defaultTimeoutMs;

        // Sanitize user-supplied headers: reject CRLF sequences and restrict header names
        const sanitizedHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
            if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
                this.logger.warn(`[${taskId}] Dropping header "${name.replace(/[\r\n]/g, '')}" — contains CRLF`);
                continue;
            }
            sanitizedHeaders[name] = value;
        }

        const finalHeaders = {
            ...sanitizedHeaders,
            'X-Notitia-Task-ID': taskId,
        };

        this.logger.log(`[${taskId}] Executing ${method} ${safeUrl(target)}`);

        try {
            const axiosConfig: AxiosRequestConfig = {
                method: method as Method,
                url: target,
                headers: finalHeaders,
                params: params,
                timeout: timeoutMs,
            };

            if (payload && (method === HttpMethod.POST || method === HttpMethod.PUT || method === HttpMethod.PATCH)) {
                axiosConfig.data = payload;
            }

            const response = await axios(axiosConfig);
            const duration = Date.now() - startTime;

            this.logger.log(`[${taskId}] Success ${response.status} (${duration}ms)`);

            return {
                success: true,
                status: response.status,
                duration,
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const errorData = error.response?.data;

                this.logger.error(`[${taskId}] Failed ${status || 'NETWORK'} (${duration}ms): ${error.message}${errorData ? ` - ${JSON.stringify(errorData)}` : ''}`);

                return {
                    success: false,
                    status,
                    error: error.message,
                    duration,
                };
            } else {
                this.logger.error(`[${taskId}] Failed UNKNOWN (${duration}ms): ${error instanceof Error ? error.message : String(error)}`);

                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    duration,
                };
            }
        }
    }
} 