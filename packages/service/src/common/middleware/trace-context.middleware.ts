import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { parseCloudTrace, CloudTraceFields } from '../logger/trace';

declare module 'express-serve-static-core' {
    interface Request {
        traceContext?: CloudTraceFields;
    }
}

@Injectable()
export class TraceContextMiddleware implements NestMiddleware {
    use(req: Request, _res: Response, next: NextFunction) {
        const header = req.headers['x-cloud-trace-context'] as string | undefined;
        req.traceContext = parseCloudTrace(header, process.env.GCP_PROJECT_ID);
        next();
    }
}
