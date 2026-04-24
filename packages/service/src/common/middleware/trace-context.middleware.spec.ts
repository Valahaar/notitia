import { TraceContextMiddleware } from './trace-context.middleware';

describe('TraceContextMiddleware', () => {
    const originalProject = process.env.GCP_PROJECT_ID;

    afterEach(() => {
        if (originalProject === undefined) delete process.env.GCP_PROJECT_ID;
        else process.env.GCP_PROJECT_ID = originalProject;
    });

    it('attaches parsed fields to req.traceContext when header present', () => {
        process.env.GCP_PROJECT_ID = 'test-proj';
        const mw = new TraceContextMiddleware();
        const req: any = { headers: { 'x-cloud-trace-context': 'abc/12;o=1' } };
        const next = jest.fn();
        mw.use(req, {} as any, next);
        expect(req.traceContext).toEqual({
            'logging.googleapis.com/trace': 'projects/test-proj/traces/abc',
            'logging.googleapis.com/spanId': '12',
            'logging.googleapis.com/trace_sampled': true,
        });
        expect(next).toHaveBeenCalled();
    });

    it('sets req.traceContext to {} when header absent', () => {
        const mw = new TraceContextMiddleware();
        const req: any = { headers: {} };
        const next = jest.fn();
        mw.use(req, {} as any, next);
        expect(req.traceContext).toEqual({});
        expect(next).toHaveBeenCalled();
    });
});
