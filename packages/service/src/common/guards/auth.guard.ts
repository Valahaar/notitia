import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name);

    constructor(private readonly configService: ConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        if (!authHeader) {
            this.logger.warn('Missing Authorization header');
            throw new UnauthorizedException('Missing Authorization header');
        }

        if (!authHeader.startsWith('Bearer ')) {
            this.logger.warn('Malformed Authorization header');
            throw new UnauthorizedException('Malformed Authorization header');
        }

        const token = authHeader.slice(7); // len('Bearer ') === 7
        const expectedToken = this.configService.get<string>('AUTH_TOKEN');

        if (!expectedToken) {
            this.logger.error('AUTH_TOKEN environment variable not configured');
            throw new UnauthorizedException('Authentication not properly configured');
        }

        const tokenBuf = Buffer.from(token);
        const expectedBuf = Buffer.from(expectedToken);

        if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
            this.logger.warn('Invalid authentication token provided');
            throw new UnauthorizedException('Invalid authentication token');
        }

        this.logger.debug('Authentication successful');
        return true;
    }
}
