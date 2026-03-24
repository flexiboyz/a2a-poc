export function formatGeneric(eventType: string, data: any, runId: string): Record<string, any> {
  return {
    event: eventType,
    run_id: runId,
    agent: data.agent ?? null,
    step: data.step ?? null,
    timestamp: new Date().toISOString(),
    data,
  };
}
