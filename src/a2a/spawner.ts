/**
 * Context Accumulator — builds pipeline_context YAML for agents (§7, §11.3)
 *
 * Reads completed run_steps from SQLite, parses outputs with Zod schemas,
 * and assembles structured context for the next agent in the pipeline.
 *
 * §11.3 — Token optimization: agents within full_context_depth get full output,
 * older agents get a ~200-token summary to reduce accumulated context size.
 */

import db from "../db.js";
import YAML from "js-yaml";
import { agentSchemas } from "../schemas/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface PreviousAgent {
  agent: string;
  output: unknown; // Parsed YAML object or raw string
  summarized?: boolean; // true when output is a summary, not full output
}

interface PipelineContext {
  pipeline_context: {
    task: {
      input: string;
    };
    previous_agents: PreviousAgent[];
    current_step: number;
    total_steps: number;
    current_iteration: number;
    max_iterations: number;
  };
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Build accumulated pipeline_context for a given run step.
 * Reads all completed steps before `currentStepOrder` and assembles §7 structure.
 *
 * fullContextDepth controls how many preceding agents get full output (default: 1).
 * Agents beyond that depth get summary_output instead (if available).
 */
export function buildPipelineContext(
  runId: string,
  currentStepOrder: number,
  input: string,
  totalSteps: number,
  currentIteration: number = 1,
  maxIterations: number = 3,
  fullContextDepth: number = 1,
): PipelineContext {
  // Query completed steps before current — include summary_output for context optimization
  const completedSteps = db
    .prepare(
      `SELECT agent_name, step_order, output, summary_output FROM run_steps
       WHERE run_id = ? AND step_order < ? AND status = 'completed'
       ORDER BY step_order`,
    )
    .all(runId, currentStepOrder) as {
      agent_name: string;
      step_order: number;
      output: string | null;
      summary_output: string | null;
    }[];

  const previousAgents: PreviousAgent[] = completedSteps.map((step) => {
    const distanceFromCurrent = currentStepOrder - step.step_order;
    const useFullOutput = distanceFromCurrent <= fullContextDepth;

    if (useFullOutput || !step.summary_output) {
      return {
        agent: step.agent_name,
        output: parseAgentOutput(step.agent_name, step.output),
      };
    }

    // Use summary for older agents beyond fullContextDepth
    return {
      agent: step.agent_name,
      output: step.summary_output,
      summarized: true,
    };
  });

  return {
    pipeline_context: {
      task: {
        input,
      },
      previous_agents: previousAgents,
      current_step: currentStepOrder + 1, // 1-based for display
      total_steps: totalSteps,
      current_iteration: currentIteration,
      max_iterations: maxIterations,
    },
  };
}

/**
 * Parse agent output: try YAML + Zod schema first, fall back to raw string.
 * Handles agents that produce free text (Spark, Flint, Ghost, etc.).
 */
function parseAgentOutput(agentName: string, raw: string | null): unknown {
  if (!raw) return null;

  // If agent has a Zod schema, try structured parse
  const schema = agentSchemas[agentName];
  if (schema) {
    try {
      const parsed = YAML.load(raw);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch {
      // YAML parse failed — fall through to raw
    }
  }

  // No schema or parse failed — return raw text
  return raw;
}

/**
 * Format pipeline_context as YAML string for injection into agent brief.
 */
export function formatPipelineContextYaml(context: PipelineContext): string {
  return YAML.dump(context, { lineWidth: -1, noRefs: true });
}

/**
 * Generate a ~200-token summary of agent output (§11.3).
 * Extracts key fields from structured YAML output, or truncates raw text.
 */
export function generateSummary(output: string): string {
  try {
    const parsed = YAML.load(output) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const parts: string[] = [];

      if (parsed.agent) parts.push(`agent: ${parsed.agent}`);
      if (parsed.status) parts.push(`status: ${parsed.status}`);

      const out = parsed.output as Record<string, unknown> | undefined;
      if (out && typeof out === "object") {
        if (out.summary) parts.push(`summary: ${out.summary}`);
        if (out.verdict) parts.push(`verdict: ${out.verdict}`);
        if (out.branch) parts.push(`branch: ${out.branch}`);
        if (out.build_status) parts.push(`build_status: ${out.build_status}`);
        if (out.pull_request && typeof out.pull_request === "object") {
          const pr = out.pull_request as Record<string, unknown>;
          if (pr.url) parts.push(`pr: ${pr.url}`);
        }
        if (Array.isArray(out.files_changed)) {
          const files = (out.files_changed as Array<Record<string, unknown>>)
            .map(f => f.path)
            .slice(0, 5);
          parts.push(`files: ${files.join(", ")}`);
        }
      }

      if (parts.length > 0) {
        const summary = parts.join("\n");
        return summary.length > 800 ? summary.slice(0, 797) + "..." : summary;
      }
    }
  } catch {
    // Not YAML — fall through to text truncation
  }

  if (output.length <= 800) return output;
  return output.slice(0, 797) + "...";
}

/**
 * Store summary_output for a completed run step.
 */
export function storeSummary(runId: string, stepOrder: number, summary: string): void {
  db.prepare("UPDATE run_steps SET summary_output = ? WHERE run_id = ? AND step_order = ?")
    .run(summary, runId, stepOrder);
}
