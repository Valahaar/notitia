export type CloudTraceFields = Partial<{
    'logging.googleapis.com/trace': string;
    'logging.googleapis.com/spanId': string;
    'logging.googleapis.com/trace_sampled': boolean;
}>;

const HEADER_RE = /^([a-f0-9]+)(?:\/(\d+))?(?:;o=([01]))?$/i;

export function parseCloudTrace(header: string | undefined, projectId: string | undefined): CloudTraceFields {
    if (!header) return {};
    const match = HEADER_RE.exec(header);
    if (!match) return {};

    const [, traceId, spanId, sampled] = match;
    const trace = projectId ? `projects/${projectId}/traces/${traceId}` : traceId;

    const out: CloudTraceFields = { 'logging.googleapis.com/trace': trace };
    if (spanId) out['logging.googleapis.com/spanId'] = spanId;
    if (sampled !== undefined) out['logging.googleapis.com/trace_sampled'] = sampled === '1';
    return out;
}
