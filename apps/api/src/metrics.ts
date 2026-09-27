// In-memory request metrics — surfaced via GET /api/admin/metrics.
export const metrics = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0, // 5xx
  byStatus: {} as Record<string, number>,
};

export function onResponseMetric(statusCode: number) {
  metrics.requests++;
  const bucket = `${Math.floor(statusCode / 100)}xx`;
  metrics.byStatus[bucket] = (metrics.byStatus[bucket] ?? 0) + 1;
  if (statusCode >= 500) metrics.errors++;
}
