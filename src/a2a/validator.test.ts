import { describe, it, expect } from "vitest";
import { validate, formatRetryFeedback, type ValidationFailure } from "./validator.js";

const validCipherYaml = `
agent: Cipher
task_seq: 42
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  summary: "Analysis complete"
  files_impacted:
    - path: src/foo.ts
      action: modify
      reason: needs update
  risks:
    - level: low
      description: minimal risk
  dependencies:
    - zod
  recommendations:
    - use vitest
`.trim();

describe("validate", () => {
  it("parses valid YAML and validates successfully", () => {
    const result = validate("Cipher", validCipherYaml);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("agent", "Cipher");
      expect(result.data).toHaveProperty("output.summary", "Analysis complete");
    }
  });

  it("returns structured errors for malformed YAML", () => {
    const result = validate("Cipher", "{ invalid: yaml: :");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]!.expected).toBe("valid YAML");
    }
  });

  it("returns error for non-object YAML", () => {
    const result = validate("Cipher", "just a string");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]!.expected).toBe("YAML object");
    }
  });

  it("returns header validation errors for missing fields", () => {
    const yaml = `
agent: Cipher
status: done
`.trim();
    const result = validate("Cipher", yaml);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.path.includes("task_seq"))).toBe(true);
    }
  });

  it("returns error for unknown agent", () => {
    const yaml = `
agent: Unknown
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
`.trim();
    const result = validate("UnknownAgent", yaml);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]!.path).toBe("agent");
      expect(result.errors[0]!.received).toBe("UnknownAgent");
    }
  });

  it("returns agent-specific schema errors", () => {
    const yaml = `
agent: Cipher
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  summary: "ok"
`.trim();
    // Missing required fields in CipherOutputSchema (files_impacted, risks, etc.)
    const result = validate("Cipher", yaml);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("formatRetryFeedback", () => {
  it("formats retry feedback with fix suggestions", () => {
    const failure: ValidationFailure = {
      success: false,
      errors: [
        { path: "output.summary", expected: "string", received: "undefined" },
      ],
      raw: "bad yaml",
    };
    const feedback = formatRetryFeedback(failure, 1, 3);
    expect(feedback.validation_error.attempt).toBe(1);
    expect(feedback.validation_error.max_attempts).toBe(3);
    expect(feedback.validation_error.errors[0]!.fix).toContain("Add output.summary");
    expect(feedback.validation_error.previous_output).toBe("bad yaml");
  });

  it("suggests change fix for wrong type", () => {
    const failure: ValidationFailure = {
      success: false,
      errors: [
        { path: "status", expected: "done | fail", received: "invalid" },
      ],
      raw: "status: invalid",
    };
    const feedback = formatRetryFeedback(failure, 2);
    expect(feedback.validation_error.errors[0]!.fix).toContain("Change 'invalid'");
  });
});
