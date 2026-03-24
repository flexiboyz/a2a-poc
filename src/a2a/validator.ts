import { z } from "zod";
import YAML from "js-yaml";
import { CommonHeaderSchema } from "../schemas/common.js";
import { WorkflowMasterSchema } from "../schemas/workflowmaster.js";
import { CipherSchema } from "../schemas/cipher.js";
import { AssemblerSchema } from "../schemas/assembler.js";
import { SentinelSchema } from "../schemas/sentinel.js";
import { HammerSchema } from "../schemas/hammer.js";
import { PrismSchema } from "../schemas/prism.js";
import { BastionSchema } from "../schemas/bastion.js";

// --- Types ---

export interface StructuredError {
  path: string;
  expected: string;
  received: string;
}

export interface ValidationSuccess {
  success: true;
  data: unknown;
}

export interface ValidationFailure {
  success: false;
  errors: StructuredError[];
  raw: string;
}

export type ValidateResult = ValidationSuccess | ValidationFailure;

export interface RetryFeedback {
  validation_error: {
    attempt: number;
    max_attempts: number;
    instruction: string;
    errors: Array<StructuredError & { fix: string }>;
    previous_output: string;
  };
}

// --- Schema registry ---

const agentSchemas: Record<string, z.ZodType> = {
  WorkflowMaster: WorkflowMasterSchema,
  Cipher: CipherSchema,
  Assembler: AssemblerSchema,
  Sentinel: SentinelSchema,
  Hammer: HammerSchema,
  Prism: PrismSchema,
  Bastion: BastionSchema,
};

// --- Helpers ---

function zodIssuesToStructuredErrors(issues: z.ZodIssue[]): StructuredError[] {
  return issues.map((issue) => {
    const path = issue.path.join(".");
    const expected = "expected" in issue ? String(issue.expected) : issue.code;
    const received = "received" in issue ? String(issue.received) : "undefined";
    return { path, expected, received };
  });
}

function generateFix(error: StructuredError): string {
  if (error.received === "undefined" || error.received === "null") {
    return `Add ${error.path} field (expected ${error.expected})`;
  }
  return `Change '${error.received}' to ${error.expected} at ${error.path}`;
}

// --- Core validation pipeline ---

/**
 * Two-step validation: parse YAML → validate header → validate full schema.
 */
export function validate(agentName: string, yamlString: string): ValidateResult {
  // Step 1: Parse YAML
  let parsed: unknown;
  try {
    parsed = YAML.load(yamlString, { schema: YAML.DEFAULT_SCHEMA });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      errors: [{ path: "", expected: "valid YAML", received: message }],
      raw: yamlString,
    };
  }

  if (parsed == null || typeof parsed !== "object") {
    return {
      success: false,
      errors: [{ path: "", expected: "YAML object", received: String(parsed) }],
      raw: yamlString,
    };
  }

  // Step 2: Validate common header
  const headerResult = CommonHeaderSchema.safeParse(parsed);
  if (!headerResult.success) {
    return {
      success: false,
      errors: zodIssuesToStructuredErrors(headerResult.error.issues),
      raw: yamlString,
    };
  }

  // Step 3: Validate full agent-specific schema
  const schema = agentSchemas[agentName];
  if (!schema) {
    return {
      success: false,
      errors: [
        {
          path: "agent",
          expected: Object.keys(agentSchemas).join(" | "),
          received: agentName,
        },
      ],
      raw: yamlString,
    };
  }

  const fullResult = schema.safeParse(parsed);
  if (!fullResult.success) {
    return {
      success: false,
      errors: zodIssuesToStructuredErrors(fullResult.error.issues),
      raw: yamlString,
    };
  }

  return { success: true, data: fullResult.data };
}

// --- Retry feedback generator (§5.3) ---

export function formatRetryFeedback(
  failure: ValidationFailure,
  attempt: number,
  maxAttempts: number = 3
): RetryFeedback {
  return {
    validation_error: {
      attempt,
      max_attempts: maxAttempts,
      instruction:
        "Your output failed Zod validation. Fix the errors below and resubmit.",
      errors: failure.errors.map((e) => ({ ...e, fix: generateFix(e) })),
      previous_output: failure.raw,
    },
  };
}
