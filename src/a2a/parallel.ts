/**
 * Parallel execution support for pipeline groups.
 *
 * A pipeline step can be either a single agent name (string) or a group
 * of agents that run in parallel ({ group: string[], failure_strategy? }).
 * This module normalizes, merges, and finalizes group execution.
 */

import db from "../db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type FailureStrategy = "fail_all" | "continue_partial";

export type PipelineStep =
  | string
  | { group: string[]; failure_strategy?: FailureStrategy };

export interface NormalizedGroup {
  agents: string[];
  failureStrategy: FailureStrategy;
}

export interface AgentResult {
  agentName: string;
  status: "completed" | "failed";
  output: string;
  pipelineSuggestion?: string | null;
}

export interface GroupResult {
  status: "completed" | "failed" | "partial";
  mergedOutput: string;
  results: AgentResult[];
  deferredSuggestions: Array<{ agentName: string; suggestion: string }>;
}

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Converts a mixed pipeline array (strings and group objects) into
 * an array of NormalizedGroup. Single agent strings become groups of one.
 */
export function normalizePipeline(steps: PipelineStep[]): NormalizedGroup[] {
  return steps.map((step) => {
    if (typeof step === "string") {
      return { agents: [step], failureStrategy: "fail_all" as FailureStrategy };
    }
    return {
      agents: step.group,
      failureStrategy: step.failure_strategy ?? "fail_all",
    };
  });
}

/**
 * Combines outputs from parallel agent results into a single string.
 * Each agent's output is wrapped with a header for downstream context.
 */
export function mergeGroupOutputs(results: AgentResult[]): string {
  return results
    .filter((r) => r.status === "completed")
    .map((r) => `## ${r.agentName} Output\n${r.output}`)
    .join("\n\n---\n\n");
}

/**
 * Determines the overall group status based on individual results
 * and the configured failure strategy.
 */
export function resolveGroupStatus(
  results: AgentResult[],
  failureStrategy: FailureStrategy,
): "completed" | "failed" | "partial" {
  const allCompleted = results.every((r) => r.status === "completed");
  if (allCompleted) return "completed";

  const someCompleted = results.some((r) => r.status === "completed");
  if (failureStrategy === "continue_partial" && someCompleted) return "partial";

  return "failed";
}

/**
 * Updates the run_groups table with the final status and merged output.
 */
export function finalizeGroup(
  groupId: string,
  status: string,
  mergedOutput: string,
): void {
  db.prepare(
    "UPDATE run_groups SET status = ?, merged_output = ? WHERE id = ?",
  ).run(status, mergedOutput, groupId);
}

/**
 * Returns the total number of individual agent steps across all groups.
 */
export function getTotalStepCount(groups: NormalizedGroup[]): number {
  return groups.reduce((sum, g) => sum + g.agents.length, 0);
}

/**
 * Returns a flat list of all agent names across all groups.
 */
export function getAllAgentNames(groups: NormalizedGroup[]): string[] {
  return groups.flatMap((g) => g.agents);
}
