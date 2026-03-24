/**
 * E2E Pipeline Tests — validates full pipeline orchestration logic.
 *
 * Tests callback-handler, validator, spawner and parallel modules
 * against an in-memory SQLite DB with deterministic YAML fixtures.
 *
 * 6 scenarios:
 *   1. Happy path: full pipeline completes
 *   2. Validation fail + retry
 *   3. Escalation: 3rd retry fails → waiting_user
 *   4. Change request: Sentinel rejects → Assembler re-runs
 *   5. Pipeline suggestion: agent suggests adding Prism → pause
 *   6. Out of scope: agent flags items → tickets created
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── DB mock (hoisted before all imports) ──────────────────────────────────

vi.mock("../db.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  return { default: createTestDb() };
});

// ── Imports (use mocked db) ──────────────────────────────────────────────

import { v4 as uuidv4 } from "uuid";
import YAML from "js-yaml";
import { cleanDb } from "./helpers/test-db.js";
import db from "../db.js";
import { validate, formatRetryFeedback, type ValidationFailure } from "../a2a/validator.js";
import { buildPipelineContext, formatPipelineContextYaml } from "../a2a/spawner.js";
import {
  type CallbackContext,
  handleDone,
  handleValidationFail,
  handleChangeRequest,
  handlePipelineSuggestion,
  detectChangeRequest,
  detectPipelineSuggestion,
  escalateToUser,
  abortPipeline,
  resetCallbacksCache,
  getMaxRetries,
  handleGroupComplete,
  handleGroupPartialFail,
} from "../a2a/callback-handler.js";
import {
  normalizePipeline,
  mergeGroupOutputs,
  resolveGroupStatus,
  finalizeGroup,
  type AgentResult,
} from "../a2a/parallel.js";
import {
  VALID_CIPHER_YAML,
  VALID_ASSEMBLER_YAML,
  VALID_SENTINEL_YAML,
  INVALID_CIPHER_YAML,
  CIPHER_WITH_OUT_OF_SCOPE,
  OUTPUT_WITH_CHANGE_REQUEST,
  OUTPUT_WITH_PIPELINE_SUGGESTION,
  PIPELINE_SUGGESTION_TEXT,
} from "./fixtures/pipelines.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function seedPipeline(agents: string[]): { pipelineId: string; runId: string } {
  const pipelineId = uuidv4();
  const runId = uuidv4();

  db.prepare("INSERT INTO pipelines (id, name, agents) VALUES (?, ?, ?)")
    .run(pipelineId, "Test Pipeline", JSON.stringify(agents));
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)")
    .run(runId, pipelineId, "Test input");

  for (let i = 0; i < agents.length; i++) {
    db.prepare(
      "INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')",
    ).run(uuidv4(), runId, agents[i]!, i);
  }

  return { pipelineId, runId };
}

function createCtx(
  runId: string,
  stepIndex: number,
  agentName: string,
  agentNames: string[],
  pendingInputs?: Map<string, any>,
): CallbackContext {
  return {
    runId,
    stepIndex,
    agentName,
    agentEmoji: "🔧",
    agentSlug: agentName.toLowerCase(),
    agentNames,
    groupId: null,
    broadcast: vi.fn(),
    pendingInputs: pendingInputs ?? new Map(),
  };
}

function getRunStatus(runId: string): string {
  return (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as any).status;
}

function getStepStatus(runId: string, stepOrder: number): string {
  return (
    db
      .prepare("SELECT status FROM run_steps WHERE run_id = ? AND step_order = ?")
      .get(runId, stepOrder) as any
  ).status;
}

function getStepOutput(runId: string, stepOrder: number): string | null {
  return (
    db
      .prepare("SELECT output FROM run_steps WHERE run_id = ? AND step_order = ?")
      .get(runId, stepOrder) as any
  ).output;
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  cleanDb(db);
  resetCallbacksCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: Happy path — full pipeline completes
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 1: Happy path — full pipeline completes", () => {
  it("runs Cipher → Assembler → Sentinel, each producing Zod-valid YAML", () => {
    const agents = ["Cipher", "Assembler", "Sentinel"];
    const outputs = [VALID_CIPHER_YAML, VALID_ASSEMBLER_YAML, VALID_SENTINEL_YAML];
    const { runId } = seedPipeline(agents);

    for (let i = 0; i < agents.length; i++) {
      // Mark running
      db.prepare(
        "UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?",
      ).run(runId, i);

      // Validate output against agent schema
      const result = validate(agents[i]!, outputs[i]!);
      expect(result.success, `${agents[i]} output should be valid`).toBe(true);

      // on_done callback → continue
      const ctx = createCtx(runId, i, agents[i]!, agents);
      const cbResult = handleDone(ctx, outputs[i]!, []);
      expect(cbResult.outcome).toBe("continue");

      // Step marked completed in DB
      expect(getStepStatus(runId, i)).toBe("completed");
      expect(getStepOutput(runId, i)).toBe(outputs[i]);
    }

    // Pipeline done
    db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
    expect(getRunStatus(runId)).toBe("completed");
  });

  it("accumulates context between pipeline steps", () => {
    const agents = ["Cipher", "Assembler", "Sentinel"];
    const { runId } = seedPipeline(agents);

    // Complete Cipher (step 0)
    db.prepare(
      "UPDATE run_steps SET status = 'completed', output = ? WHERE run_id = ? AND step_order = ?",
    ).run(VALID_CIPHER_YAML, runId, 0);

    // Build context for Assembler (step 1)
    const ctx1 = buildPipelineContext(runId, 1, "Test input", 3);
    expect(ctx1.pipeline_context.previous_agents).toHaveLength(1);
    expect(ctx1.pipeline_context.previous_agents[0]!.agent).toBe("Cipher");
    expect(ctx1.pipeline_context.current_step).toBe(2); // 1-based

    // Complete Assembler (step 1)
    db.prepare(
      "UPDATE run_steps SET status = 'completed', output = ? WHERE run_id = ? AND step_order = ?",
    ).run(VALID_ASSEMBLER_YAML, runId, 1);

    // Build context for Sentinel (step 2)
    const ctx2 = buildPipelineContext(runId, 2, "Test input", 3);
    expect(ctx2.pipeline_context.previous_agents).toHaveLength(2);
    expect(ctx2.pipeline_context.previous_agents[0]!.agent).toBe("Cipher");
    expect(ctx2.pipeline_context.previous_agents[1]!.agent).toBe("Assembler");
    expect(ctx2.pipeline_context.current_step).toBe(3);
    expect(ctx2.pipeline_context.total_steps).toBe(3);
  });

  it("produces valid YAML pipeline context string", () => {
    const { runId } = seedPipeline(["Cipher", "Assembler"]);
    db.prepare(
      "UPDATE run_steps SET status = 'completed', output = ? WHERE run_id = ? AND step_order = ?",
    ).run(VALID_CIPHER_YAML, runId, 0);

    const pCtx = buildPipelineContext(runId, 1, "Test input", 2);
    const yaml = formatPipelineContextYaml(pCtx);
    expect(yaml).toContain("pipeline_context");
    expect(yaml).toContain("previous_agents");
    // Should be parseable YAML
    const parsed = YAML.load(yaml) as Record<string, unknown>;
    expect(parsed).toHaveProperty("pipeline_context");
  });

  it("broadcasts step-completed for each agent", () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 0, "Cipher", agents);
    ctx.broadcast = broadcastFn;

    handleDone(ctx, VALID_CIPHER_YAML, []);

    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "step-completed",
        agent: "Cipher",
        step: 0,
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Validation fail + retry succeeds
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 2: Validation fail + retry succeeds", () => {
  it("detects invalid YAML and retries with feedback", async () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    const ctx = createCtx(runId, 0, "Cipher", agents);
    const maxAttempts = getMaxRetries("Cipher");

    // Attempt 1: invalid → should retry
    const badResult = validate("Cipher", INVALID_CIPHER_YAML);
    expect(badResult.success).toBe(false);

    const validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }> = [];
    const cbResult = await handleValidationFail(
      ctx,
      badResult as ValidationFailure,
      1,
      maxAttempts,
      validationAttempts,
      "original input",
    );

    expect(cbResult.outcome).toBe("retry");
    expect(validationAttempts).toHaveLength(1);

    if (cbResult.outcome === "retry") {
      expect(cbResult.input).toContain("validation_error");
    }

    // Attempt 2: valid → on_done
    const goodResult = validate("Cipher", VALID_CIPHER_YAML);
    expect(goodResult.success).toBe(true);

    const doneResult = handleDone(ctx, VALID_CIPHER_YAML, validationAttempts);
    expect(doneResult.outcome).toBe("continue");

    // Validation errors persisted with step
    const step = db
      .prepare("SELECT validation_errors FROM run_steps WHERE run_id = ? AND step_order = 0")
      .get(runId) as { validation_errors: string | null };
    expect(step.validation_errors).not.toBeNull();
    const errors = JSON.parse(step.validation_errors!);
    expect(errors).toHaveLength(1);
    expect(errors[0].attempt).toBe(1);
  });

  it("formats retry feedback with structured errors and fix suggestions", () => {
    const badResult = validate("Cipher", INVALID_CIPHER_YAML);
    expect(badResult.success).toBe(false);

    const feedback = formatRetryFeedback(badResult as ValidationFailure, 1, 3);
    expect(feedback.validation_error.attempt).toBe(1);
    expect(feedback.validation_error.max_attempts).toBe(3);
    expect(feedback.validation_error.instruction).toContain("Fix the errors");
    expect(feedback.validation_error.errors.length).toBeGreaterThan(0);
    expect(feedback.validation_error.errors[0]!.fix).toBeDefined();
    expect(feedback.validation_error.previous_output).toBe(INVALID_CIPHER_YAML);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: Escalation — max retries → waiting_user
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 3: Escalation after max retries → waiting_user", () => {
  it("retries up to max, then escalates; user aborts → pipeline failed", async () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    const pendingInputs = new Map<string, any>();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);
    const maxAttempts = 3;
    const validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }> = [];

    // Attempts 1 and 2 → retry
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      const badResult = validate("Cipher", INVALID_CIPHER_YAML) as ValidationFailure;
      const cbResult = await handleValidationFail(
        ctx,
        badResult,
        attempt,
        maxAttempts,
        validationAttempts,
        "input",
      );
      expect(cbResult.outcome).toBe("retry");
    }

    expect(validationAttempts).toHaveLength(2);

    // Attempt 3: exhausted → escalateToUser
    setTimeout(() => {
      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("abort");
    }, 10);

    const badResult = validate("Cipher", INVALID_CIPHER_YAML) as ValidationFailure;
    const cbResult = await handleValidationFail(
      ctx,
      badResult,
      maxAttempts,
      maxAttempts,
      validationAttempts,
      "input",
    );

    expect(cbResult.outcome).toBe("abort");
    expect(getRunStatus(runId)).toBe("waiting_user");
    expect(getStepStatus(runId, 0)).toBe("waiting_user");
  });

  it("escalation: user chooses retry → reset outcome", async () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    const pendingInputs = new Map<string, any>();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);

    const validationAttempts = [
      { attempt: 1, errors: [], raw: "bad1" },
      { attempt: 2, errors: [], raw: "bad2" },
      { attempt: 3, errors: [], raw: "bad3" },
    ];

    setTimeout(() => {
      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("retry");
    }, 10);

    const result = await escalateToUser(ctx, validationAttempts, 3);
    expect(result.outcome).toBe("reset");
  });

  it("escalation: user provides fix → fix outcome with output", async () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    const pendingInputs = new Map<string, any>();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);

    setTimeout(() => {
      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("fix: corrected YAML output");
    }, 10);

    const result = await escalateToUser(ctx, [], 3);
    expect(result.outcome).toBe("fix");
    if (result.outcome === "fix") {
      expect(result.output).toBe("corrected YAML output");
    }
  });

  it("abortPipeline cancels remaining steps", () => {
    const agents = ["Cipher", "Assembler", "Sentinel"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 0, "Cipher", agents);
    ctx.broadcast = broadcastFn;

    abortPipeline(ctx, "User aborted");

    // Current step failed
    expect(getStepStatus(runId, 0)).toBe("failed");
    // Remaining steps canceled
    expect(getStepStatus(runId, 1)).toBe("canceled");
    expect(getStepStatus(runId, 2)).toBe("canceled");
    // Run failed
    expect(getRunStatus(runId)).toBe("failed");
    // Broadcasts fired
    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ type: "pipeline-failed" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Change request — Sentinel rejects → Assembler re-runs
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 4: Change request detection and handling", () => {
  it("detects CHANGE_REQUEST marker in output", () => {
    const changeCtx = detectChangeRequest(OUTPUT_WITH_CHANGE_REQUEST);
    expect(changeCtx).not.toBeNull();
    expect(changeCtx).toContain("Assembler needs to fix formatting");
  });

  it("returns null when marker absent", () => {
    expect(detectChangeRequest(VALID_CIPHER_YAML)).toBeNull();
  });

  it("handleChangeRequest dispatches to target agent (Assembler)", async () => {
    const agents = ["Cipher", "Assembler", "Sentinel"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 2").run(
      runId,
    );

    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 2, "Sentinel", agents);
    ctx.broadcast = broadcastFn;

    const result = await handleChangeRequest(ctx, "Fix formatting in src/foo.ts");

    expect(result.outcome).toBe("continue");
    expect(getStepStatus(runId, 2)).toBe("completed");
    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "step-change-request",
        agent: "Sentinel",
        targetAgent: "Assembler",
      }),
    );
  });

  it("change request output includes context", async () => {
    const agents = ["Sentinel"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const ctx = createCtx(runId, 0, "Sentinel", agents);
    await handleChangeRequest(ctx, "Rewrite the entire component");

    const output = getStepOutput(runId, 0);
    expect(output).toContain("Change request");
    expect(output).toContain("Assembler");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5: Pipeline suggestion — agent suggests adding Prism → pause
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 5: Pipeline suggestion — pause, user approves", () => {
  it("detects PIPELINE_SUGGESTION marker", () => {
    const suggestion = detectPipelineSuggestion(OUTPUT_WITH_PIPELINE_SUGGESTION);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("insert_after_current");
    expect(suggestion).toContain("Prism");
  });

  it("returns null when marker absent", () => {
    expect(detectPipelineSuggestion(VALID_CIPHER_YAML)).toBeNull();
  });

  it("user approves → modify_pipeline with parsed suggestion", async () => {
    const agents = ["Cipher", "Assembler", "Sentinel"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const pendingInputs = new Map<string, any>();
    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);
    ctx.broadcast = broadcastFn;

    const suggestion = detectPipelineSuggestion(OUTPUT_WITH_PIPELINE_SUGGESTION)!;

    setTimeout(() => {
      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("approve");
    }, 10);

    const result = await handlePipelineSuggestion(ctx, suggestion);

    expect(result.outcome).toBe("modify_pipeline");
    if (result.outcome === "modify_pipeline") {
      expect(result.suggestion.action).toBe("insert_after_current");
      expect(result.suggestion.agent).toBe("Prism");
      expect(result.suggestion.reason).toContain("design review");
    }

    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ type: "step-pipeline-suggestion" }),
    );
  });

  it("user dismisses → continue without modification", async () => {
    const agents = ["Cipher", "Assembler"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const pendingInputs = new Map<string, any>();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);

    const suggestion = detectPipelineSuggestion(OUTPUT_WITH_PIPELINE_SUGGESTION)!;

    setTimeout(() => {
      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("dismiss");
    }, 10);

    const result = await handlePipelineSuggestion(ctx, suggestion);
    expect(result.outcome).toBe("continue");

    // Step completed, run resumed
    expect(getStepStatus(runId, 0)).toBe("completed");
    expect(getRunStatus(runId)).toBe("running");
  });

  it("sets waiting_user during pause", async () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);
    db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = 0").run(
      runId,
    );

    const pendingInputs = new Map<string, any>();
    const ctx = createCtx(runId, 0, "Cipher", agents, pendingInputs);
    const suggestion = detectPipelineSuggestion(OUTPUT_WITH_PIPELINE_SUGGESTION)!;

    // Delay reply to check intermediate state
    setTimeout(() => {
      // Verify waiting state BEFORE resolving
      expect(getRunStatus(runId)).toBe("waiting_user");
      expect(getStepStatus(runId, 0)).toBe("waiting_user");

      const pending = pendingInputs.get(runId);
      if (pending) pending.resolve("approve");
    }, 20);

    await handlePipelineSuggestion(ctx, suggestion);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6: Out of scope — agent flags items → tickets created
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 6: Out of scope items → backlog tickets", () => {
  it("validates YAML with out_of_scope items via Zod schema", () => {
    const result = validate("Cipher", CIPHER_WITH_OUT_OF_SCOPE);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as any;
      expect(data.out_of_scope).toHaveLength(2);
      expect(data.out_of_scope[0].title).toBe("Add dark mode");
      expect(data.out_of_scope[1].title).toBe("Upgrade to React 19");
    }
  });

  it("creates backlog tickets from out_of_scope items", () => {
    const agents = ["Cipher"];
    const { runId } = seedPipeline(agents);

    // Replicate processOutOfScope logic (server.ts internal)
    const parsed = YAML.load(CIPHER_WITH_OUT_OF_SCOPE) as Record<string, unknown>;
    const outOfScope = parsed.out_of_scope as Array<{
      title: string;
      description?: string;
      priority?: string;
    }>;
    expect(outOfScope).toHaveLength(2);

    for (const item of outOfScope) {
      db.prepare(
        "INSERT INTO backlog_tickets (id, run_id, agent_name, step_order, title, description, priority) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        uuidv4(),
        runId,
        "Cipher",
        0,
        item.title,
        item.description ?? "",
        item.priority ?? "medium",
      );
    }

    // Verify tickets
    const tickets = db
      .prepare("SELECT * FROM backlog_tickets WHERE run_id = ? ORDER BY title")
      .all(runId) as any[];
    expect(tickets).toHaveLength(2);
    expect(tickets[0].title).toBe("Add dark mode");
    expect(tickets[0].priority).toBe("low");
    expect(tickets[0].agent_name).toBe("Cipher");
    expect(tickets[1].title).toBe("Upgrade to React 19");
    expect(tickets[1].priority).toBe("medium");
  });

  it("no tickets created when out_of_scope is empty", () => {
    const { runId } = seedPipeline(["Cipher"]);

    const parsed = YAML.load(VALID_CIPHER_YAML) as Record<string, unknown>;
    const outOfScope = parsed.out_of_scope as any[];
    expect(outOfScope).toHaveLength(0);

    const tickets = db
      .prepare("SELECT * FROM backlog_tickets WHERE run_id = ?")
      .all(runId) as any[];
    expect(tickets).toHaveLength(0);
  });

  it("handles out_of_scope items with optional priority", () => {
    const { runId } = seedPipeline(["Cipher"]);

    // Item without explicit priority → defaults to medium
    db.prepare(
      "INSERT INTO backlog_tickets (id, run_id, agent_name, step_order, title, description, priority) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(uuidv4(), runId, "Cipher", 0, "No priority item", "desc", "medium");

    const tickets = db
      .prepare("SELECT * FROM backlog_tickets WHERE run_id = ?")
      .all(runId) as any[];
    expect(tickets).toHaveLength(1);
    expect(tickets[0].priority).toBe("medium");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bonus: Parallel group execution
// ═══════════════════════════════════════════════════════════════════════════

describe("Bonus: Parallel group execution", () => {
  it("normalizePipeline converts mixed steps to groups", () => {
    const steps = ["Cipher", { group: ["Assembler", "Prism"], failure_strategy: "continue_partial" as const }, "Sentinel"];
    const groups = normalizePipeline(steps);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.agents).toEqual(["Cipher"]);
    expect(groups[1]!.agents).toEqual(["Assembler", "Prism"]);
    expect(groups[1]!.failureStrategy).toBe("continue_partial");
    expect(groups[2]!.agents).toEqual(["Sentinel"]);
  });

  it("resolveGroupStatus: all completed → completed", () => {
    const results: AgentResult[] = [
      { agentName: "A", status: "completed", output: "ok" },
      { agentName: "B", status: "completed", output: "ok" },
    ];
    expect(resolveGroupStatus(results, "fail_all")).toBe("completed");
  });

  it("resolveGroupStatus: one failed + fail_all → failed", () => {
    const results: AgentResult[] = [
      { agentName: "A", status: "completed", output: "ok" },
      { agentName: "B", status: "failed", output: "err" },
    ];
    expect(resolveGroupStatus(results, "fail_all")).toBe("failed");
  });

  it("resolveGroupStatus: one failed + continue_partial → partial", () => {
    const results: AgentResult[] = [
      { agentName: "A", status: "completed", output: "ok" },
      { agentName: "B", status: "failed", output: "err" },
    ];
    expect(resolveGroupStatus(results, "continue_partial")).toBe("partial");
  });

  it("mergeGroupOutputs combines completed results", () => {
    const results: AgentResult[] = [
      { agentName: "A", status: "completed", output: "output-a" },
      { agentName: "B", status: "failed", output: "error" },
      { agentName: "C", status: "completed", output: "output-c" },
    ];
    const merged = mergeGroupOutputs(results);
    expect(merged).toContain("## A Output");
    expect(merged).toContain("output-a");
    expect(merged).toContain("## C Output");
    expect(merged).toContain("output-c");
    expect(merged).not.toContain("## B Output");
  });

  it("handleGroupComplete broadcasts group-completed", () => {
    const { runId } = seedPipeline(["A", "B"]);
    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 0, "A", ["A", "B"]);
    ctx.broadcast = broadcastFn;
    ctx.groupId = "group-1";

    const result = handleGroupComplete(ctx, ["A", "B"], "merged output");
    expect(result.outcome).toBe("continue");
    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ type: "group-completed", agents: ["A", "B"] }),
    );
  });

  it("handleGroupPartialFail broadcasts group-partial-fail", () => {
    const { runId } = seedPipeline(["A", "B"]);
    const broadcastFn = vi.fn();
    const ctx = createCtx(runId, 0, "A", ["A", "B"]);
    ctx.broadcast = broadcastFn;
    ctx.groupId = "group-1";

    const result = handleGroupPartialFail(ctx, ["A", "B"], ["B"], "merged output");
    expect(result.outcome).toBe("continue");
    expect(broadcastFn).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: "group-partial-fail",
        failedAgents: ["B"],
      }),
    );
  });

  it("finalizeGroup updates run_groups table", () => {
    const { runId } = seedPipeline(["A", "B"]);
    const groupId = uuidv4();
    db.prepare(
      "INSERT INTO run_groups (id, run_id, group_order, failure_strategy, status) VALUES (?, ?, 0, 'fail_all', 'running')",
    ).run(groupId, runId);

    finalizeGroup(groupId, "completed", "merged output");

    const group = db.prepare("SELECT status, merged_output FROM run_groups WHERE id = ?").get(
      groupId,
    ) as any;
    expect(group.status).toBe("completed");
    expect(group.merged_output).toBe("merged output");
  });
});
