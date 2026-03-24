/**
 * Context Accumulator — builds pipeline_context YAML for agents (§7)
 *
 * Reads completed run_steps from SQLite, parses outputs with Zod schemas,
 * and assembles structured context for the next agent in the pipeline.
 */

import db from "../db.js";
import YAML from "js-yaml";
import { agentSchemas } from "../schemas/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface PreviousAgent {
  agent: string;
  output: unknown; // Parsed YAML object or raw string
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
 * fullContextDepth controls how many adjacent prior agents get full output.
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
  // Query completed steps before current (include summary_output)
  const completedSteps = db
    .prepare(
      `SELECT agent_name, output, summary_output, step_order FROM run_steps
       WHERE run_id = ? AND step_order < ? AND status = 'completed'
       ORDER BY step_order`,
    )
    .all(runId, currentStepOrder) as { agent_name: string; output: string | null; summary_output: string | null; step_order: number }[];

  const previousAgents: PreviousAgent[] = completedSteps.map((step) => {
    // Steps within fullContextDepth of current get full output
    const distanceFromCurrent = currentStepOrder - step.step_order;
    const useFullOutput = distanceFromCurrent <= fullContextDepth;

    if (useFullOutput || !step.summary_output) {
      return {
        agent: step.agent_name,
        output: parseAgentOutput(step.agent_name, step.output),
      };
    }

    // Use summary for older agents
    return {
      agent: step.agent_name,
      output: step.summary_output,
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
