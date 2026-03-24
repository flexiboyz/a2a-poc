/**
 * Callback handler — dispatches callbacks based on A2A task state changes.
 * Replaces hardcoded if/else chains in executePipeline().
 *
 * Loads workflow/callbacks.yaml for default + per-agent callback definitions.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import YAML from "js-yaml";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { validate, formatRetryFeedback, type ValidationFailure } from "./validator.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CallbackEvent =
  | "on_done"
  | "on_fail"
  | "on_await_user"
  | "on_change_request"
  | "on_pipeline_suggestion"
  | "on_validation_fail"
  | "on_validation_fail_final";

export type CallbackAction = string | { action: string; [key: string]: unknown };

export interface CallbacksConfig {
  defaults: Record<string, CallbackAction>;
  overrides: Record<string, Record<string, CallbackAction>>;
}

/** Normalized callback with action name + params */
export interface ResolvedCallback {
  action: string;
  max?: number;
  agent?: string;
}

/** Context passed to callback dispatch — everything needed to act */
export interface CallbackContext {
  runId: string;
  stepIndex: number;
  agentName: string;
  agentEmoji: string;
  agentSlug: string;
  agentNames: string[];
  broadcast: (runId: string, data: any) => void;
  pendingInputs: Map<string, {
    resolve: (reply: string) => void;
    stepIndex: number;
    taskId: string;
    agentSlug: string;
    question: string;
    isEscalation?: boolean;
  }>;
}

/** Result of a callback dispatch — tells the orchestrator what to do next */
export type CallbackResult =
  | { outcome: "continue" }                         // on_done: proceed to next agent
  | { outcome: "retry"; input: string }              // on_validation_fail: retry with feedback
  | { outcome: "abort" }                             // user chose abort
  | { outcome: "fix"; output: string }               // user provided fix
  | { outcome: "reset"; input: string }              // user chose retry (reset attempts)
  | { outcome: "wait_input"; userReply: string; taskId: string }  // on_await_user resolved
  | { outcome: "noop" };                             // callback handled, no further action

// ── Config loading ───────────────────────────────────────────────────────────

let _config: CallbacksConfig | null = null;

export function loadCallbacks(): CallbacksConfig {
  if (_config) return _config;
  const yamlPath = resolve(__dirname, "../../workflow/callbacks.yaml");
  const raw = readFileSync(yamlPath, "utf-8");
  _config = YAML.load(raw) as CallbacksConfig;
  return _config;
}

/** For testing — reset cached config */
export function resetCallbacksCache(): void {
  _config = null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Resolve callback for agent+event — check overrides first, fall back to defaults */
export function resolveCallback(agentName: string, event: CallbackEvent): ResolvedCallback {
  const config = loadCallbacks();
  const raw: CallbackAction | undefined =
    config.overrides?.[agentName]?.[event] ?? config.defaults[event];

  if (!raw) {
    return { action: "noop" };
  }

  if (typeof raw === "string") {
    return { action: raw };
  }

  const { action, ...params } = raw;
  return { action, ...params } as ResolvedCallback;
}

/** Get max retry attempts for an agent (from on_validation_fail config) */
export function getMaxRetries(agentName: string): number {
  const cb = resolveCallback(agentName, "on_validation_fail");
  return cb.max ?? 3;
}

// ── Callback actions ─────────────────────────────────────────────────────────

/** on_fail / on_validation_fail_final when action is "escalate_to_user" */
export async function escalateToUser(
  ctx: CallbackContext,
  validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }>,
  maxAttempts: number,
): Promise<CallbackResult> {
  db.prepare("UPDATE run_steps SET status = 'waiting_user', validation_errors = ? WHERE run_id = ? AND step_order = ?")
    .run(JSON.stringify(validationAttempts), ctx.runId, ctx.stepIndex);
  db.prepare("UPDATE runs SET status = 'waiting_user' WHERE id = ?").run(ctx.runId);

  const question = `${ctx.agentEmoji} ${ctx.agentName} failed validation ${maxAttempts} times. Choose: fix, retry, or abort.`;
  ctx.broadcast(ctx.runId, {
    type: "step-escalated",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
    attempts: validationAttempts,
    question,
  });

  const escalationReply = await new Promise<string>((resolve) => {
    ctx.pendingInputs.set(ctx.runId, {
      resolve,
      stepIndex: ctx.stepIndex,
      taskId: "",
      agentSlug: ctx.agentSlug,
      question: `${ctx.agentName} failed ${maxAttempts} times`,
      isEscalation: true,
    });
  });

  return handleEscalationReply(ctx, escalationReply);
}

/** Parse escalation reply into a CallbackResult */
function handleEscalationReply(ctx: CallbackContext, reply: string): CallbackResult {
  const action = reply.trim().toLowerCase();

  if (action === "abort" || action.startsWith("abort")) {
    return { outcome: "abort" };
  }

  if (action.startsWith("fix:")) {
    return { outcome: "fix", output: reply.slice(4).trim() };
  }

  // "retry" or "retry:<instructions>"
  const extraInstructions = action.startsWith("retry:") ? reply.slice(6).trim() : "";
  return { outcome: "reset", input: extraInstructions };
}

/** on_fail: notify_user — agent failed, notify and wait for decision */
export async function handleAgentFail(
  ctx: CallbackContext,
  errorMsg: string,
  attempt: number,
  maxAttempts: number,
  validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }>,
  chainedInput: string,
): Promise<CallbackResult> {
  const cb = resolveCallback(ctx.agentName, "on_fail");

  // Track as validation failure
  validationAttempts.push({
    attempt,
    errors: [{ path: "", expected: "success", received: "agent failure: " + errorMsg.slice(0, 200) }],
    raw: errorMsg,
  });

  if (cb.action === "retry_agent" || attempt < maxAttempts) {
    // Retry: build feedback
    const failure: ValidationFailure = {
      success: false,
      errors: [{ path: "", expected: "successful execution", received: "agent failure" }],
      raw: errorMsg,
    };
    const retryFeedback = formatRetryFeedback(failure, attempt, maxAttempts);
    const retryInput = chainedInput + "\n\n---\n\n" + YAML.dump(retryFeedback);
    return { outcome: "retry", input: retryInput };
  }

  // Final fail → escalate
  return escalateToUser(ctx, validationAttempts, maxAttempts);
}

/** on_validation_fail: retry_agent — output validation failed */
export async function handleValidationFail(
  ctx: CallbackContext,
  validationResult: ValidationFailure,
  attempt: number,
  maxAttempts: number,
  validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }>,
  chainedInput: string,
): Promise<CallbackResult> {
  validationAttempts.push({ attempt, errors: validationResult.errors, raw: validationResult.raw });

  if (attempt < maxAttempts) {
    // on_validation_fail → retry
    const retryFeedback = formatRetryFeedback(validationResult, attempt, maxAttempts);
    const retryInput = chainedInput + "\n\n---\n\n" + YAML.dump(retryFeedback);
    return { outcome: "retry", input: retryInput };
  }

  // on_validation_fail_final → escalate
  return escalateToUser(ctx, validationAttempts, maxAttempts);
}

/** on_await_user: notify_user — agent needs input, wait for reply */
export async function handleAwaitUser(
  ctx: CallbackContext,
  question: string,
  taskId: string,
): Promise<CallbackResult> {
  db.prepare("UPDATE run_steps SET status = 'input-required' WHERE run_id = ? AND step_order = ?")
    .run(ctx.runId, ctx.stepIndex);
  ctx.broadcast(ctx.runId, {
    type: "step-input-required",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
    question,
  });

  const userReply = await new Promise<string>((resolve) => {
    ctx.pendingInputs.set(ctx.runId, {
      resolve,
      stepIndex: ctx.stepIndex,
      taskId,
      agentSlug: ctx.agentSlug,
      question,
    });
  });

  db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = ?")
    .run(ctx.runId, ctx.stepIndex);
  ctx.broadcast(ctx.runId, {
    type: "step-resumed",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
  });

  return { outcome: "wait_input", userReply, taskId };
}

/** on_done: next_agent — mark step completed, continue pipeline */
export function handleDone(
  ctx: CallbackContext,
  output: string,
  validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }>,
): CallbackResult {
  const errorsJson = validationAttempts.length > 0 ? JSON.stringify(validationAttempts) : null;
  db.prepare("UPDATE run_steps SET status = 'completed', output = ?, validation_errors = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
    .run(output, errorsJson, ctx.runId, ctx.stepIndex);
  ctx.broadcast(ctx.runId, {
    type: "step-completed",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
    output,
  });
  return { outcome: "continue" };
}

/** Abort pipeline — cancel remaining steps */
export function abortPipeline(
  ctx: CallbackContext,
  reason: string,
): void {
  db.prepare("UPDATE run_steps SET status = 'failed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
    .run(reason, ctx.runId, ctx.stepIndex);
  ctx.broadcast(ctx.runId, {
    type: "step-failed",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
    output: reason,
  });

  // Cancel remaining steps
  for (let j = ctx.stepIndex + 1; j < ctx.agentNames.length; j++) {
    db.prepare("UPDATE run_steps SET status = 'canceled' WHERE run_id = ? AND step_order = ?")
      .run(ctx.runId, j);
    ctx.broadcast(ctx.runId, {
      type: "step-canceled",
      agent: ctx.agentNames[j],
      step: j,
    });
  }

  db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(ctx.runId);
  ctx.broadcast(ctx.runId, { type: "pipeline-failed", error: reason });
}

/** Resume step after escalation fix/retry */
export function resumeStep(ctx: CallbackContext): void {
  db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = ?")
    .run(ctx.runId, ctx.stepIndex);
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(ctx.runId);
  ctx.broadcast(ctx.runId, {
    type: "step-resumed",
    agent: ctx.agentName,
    step: ctx.stepIndex,
    emoji: ctx.agentEmoji,
  });
}
