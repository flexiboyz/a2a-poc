/**
 * Agent self-validation — §11.4
 *
 * Validates agent YAML output against Zod schema before submitting to orchestrator.
 * Up to 2 internal self-correction attempts via gateway re-invocation.
 */

import { validate, formatRetryFeedback } from "../a2a/validator.js";
import type { ValidationFailure } from "../a2a/validator.js";
import { agentSchemas } from "../schemas/index.js";

const MAX_SELF_CORRECTION_ATTEMPTS = 2;

export interface SelfValidationResult {
  /** The final output (may be original or self-corrected) */
  finalOutput: string;
  /** Number of self-correction attempts made (0 = valid on first try) */
  attempts: number;
  /** Whether the final output passed validation */
  selfValidated: boolean;
}

/**
 * Validate agent output and self-correct via re-invocation if invalid.
 *
 * @param agentName - Agent name (must match agentSchemas key)
 * @param output - Raw YAML output from the agent
 * @param reinvokeFn - Function to re-invoke the gateway with corrective feedback
 * @returns SelfValidationResult with final output and metadata
 */
export async function selfValidateOutput(
  agentName: string,
  output: string,
  reinvokeFn: (feedback: string) => Promise<string>,
): Promise<SelfValidationResult> {
  // Skip if no schema exists for this agent
  if (!agentSchemas[agentName]) {
    console.log(`[self-validate] No schema for "${agentName}", skipping self-validation`);
    return { finalOutput: output, attempts: 0, selfValidated: true };
  }

  let currentOutput = output;

  for (let attempt = 0; attempt <= MAX_SELF_CORRECTION_ATTEMPTS; attempt++) {
    const result = validate(agentName, currentOutput);

    if (result.success) {
      if (attempt > 0) {
        console.log(`[self-validate] ${agentName} self-corrected after ${attempt} attempt(s) ✅`);
      } else {
        console.log(`[self-validate] ${agentName} output valid on first try ✅`);
      }
      return { finalOutput: currentOutput, attempts: attempt, selfValidated: true };
    }

    // Last check was a failure — if we've exhausted retries, submit anyway
    if (attempt === MAX_SELF_CORRECTION_ATTEMPTS) {
      console.log(`[self-validate] ${agentName} failed after ${attempt} self-correction attempt(s), submitting anyway`);
      return { finalOutput: currentOutput, attempts: attempt, selfValidated: false };
    }

    // Build retry feedback and re-invoke
    const failure = result as ValidationFailure;
    const feedback = formatRetryFeedback(failure, attempt + 1, MAX_SELF_CORRECTION_ATTEMPTS);
    const feedbackYaml = JSON.stringify(feedback, null, 2);

    console.log(`[self-validate] ${agentName} attempt ${attempt + 1}/${MAX_SELF_CORRECTION_ATTEMPTS} — re-invoking with feedback`);

    try {
      currentOutput = await reinvokeFn(
        `Your previous output failed validation. Fix the errors and resubmit ONLY the corrected YAML.\n\n${feedbackYaml}\n\nPrevious output:\n${currentOutput}`
      );
    } catch (err) {
      console.error(`[self-validate] ${agentName} re-invocation failed:`, err instanceof Error ? err.message : err);
      return { finalOutput: currentOutput, attempts: attempt + 1, selfValidated: false };
    }
  }

  // Unreachable, but TypeScript needs it
  return { finalOutput: currentOutput, attempts: MAX_SELF_CORRECTION_ATTEMPTS, selfValidated: false };
}
