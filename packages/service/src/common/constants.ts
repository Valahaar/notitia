export const JOB_SCHEDULER_TOKEN = 'IJobScheduler';

/** Header carrying the schedule's id (UFID for meta-scheduled jobs) on every delivery. */
export const NOTITIA_TASK_ID_HEADER = 'X-Notitia-Task-ID';

/** Header carrying the scheduled occurrence time (ISO-8601 UTC) a delivery serves. Absent on immediate requests. */
export const NOTITIA_OCCURRENCE_HEADER = 'X-Notitia-Occurrence';
