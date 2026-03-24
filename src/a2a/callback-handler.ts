/**
 * Callback handler — dispatches callbacks based on A2A task state changes.
 * Replaces hardcoded if/else chains in executePipeline().
 *
 * Loads workflow/callbacks.yaml for default + per-agent callback definitions.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
  | { outcome: "modify_pipeline"; suggestion: PipelineSuggestion }  // pipeline_suggestion approved
  | { outcome: "noop" };                             // callback handled, no further action

export interface PipelineSuggestion {
  action: "insert_after_current" | "insert_before_next" | "replace_next";
  agent: string;
  reason: string;
}

// ── Config loading ───────────────────────────────────────────────────────────

let _config: CallbacksConfig | null = null;

const VALID_CALLBACK_EVENTS: CallbackEvent[] = [
  "on_done", "on_fail", "on_await_user", "on_change_request",
  "on_pipeline_suggestion", "on_validation_fail", "on_validation_fail_final",
];

const VALID_ACTIONS = [
  "next_agent", "notify_user", "retry_agent", "call_agent",
  "pause_and_notify_user", "escalate_to_user", "noop",
];

function validateCallbacksConfig(config: unknown): CallbacksConfig {
  if (!config || typeof config !== "object") {
    throw new Error("callbacks.yaml must be a YAML object");
  }
  const c = config as Record<string, unknown>;
  if (!c.defaults || typeof c.defaults !== "object") {
    throw new Error("callbacks.yaml must have a 'defaults' object");
  }

  // Validate defaults keys are valid events
  for (const key of Object.keys(c.defaults as object)) {
    if (!VALID_CALLBACK_EVENTS.includes(key as CallbackEvent)) {
      throw new Error(`Unknown callback event in defaults: ${key}`);
    }
    const val = (c.defaults as Record<string, unknown>)[key];
    const action = typeof val === "string" ? val : (val as any)?.action;
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(`Unknown callback action for ${key}: ${action}`);
    }
  }

  // Validate overrides structure
  if (c.overrides && typeof c.overrides === "object") {
    for (const [agent, events] of Object.entries(c.overrides as Record<string, unknown>)) {
      if (events && typeof events === "object") {
        for (const key of Object.keys(events as object)) {
          if (!VALID_CALLBACK_EVENTS.includes(key as CallbackEvent)) {
            throw new Error(`Unknown callback event in overrides.${agent}: ${key}`);
          }
        }
      }
    }
  }

  return config as CallbacksConfig;
}

export function loadCallbacks(): CallbacksConfig {
  if (_config) return _config;
  const yamlPath = resolve(__dirname, "../../workflow/callbacks.yaml");
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = YAML.load(raw);
  _config = validateCallbacksConfig(parsed);
  return _config;
}

/** For testing — reset cached config */
export function resetCallbacksCache(): void {
  _config = null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve callback for agent+event.
 * Precedence: agent overrides (callbacks.yaml) > template overrides > defaults
 */
export function resolveCallback(
  agentName: string,
  event: CallbackEvent,
  templateOverrides?: Record<string, Record<string, CallbackAction>>,
): ResolvedCallback {
  const config = loadCallbacks();

  // 1. Agent-level override (callbacks.yaml overrides section)
  let raw: CallbackAction | undefined = config.overrides?.[agentName]?.[event];

  // 2. Template-level override
  if (!raw && templateOverrides) {
    raw = templateOverrides[agentName]?.[event];
  }

  // 3. Default
  if (!raw) {
    raw = config.defaults[event];
  }

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

  if (cb.action === "retry_agent") {
    const retryMax = cb.max ?? maxAttempts;
    if (attempt < retryMax) {
      const failure: ValidationFailure = {
        success: false,
        errors: [{ path: "", expected: "successful execution", received: "agent failure" }],
        raw: errorMsg,
      };
      const retryFeedback = formatRetryFeedback(failure, attempt, retryMax);
      const retryInput = chainedInput + "\n\n---\n\n" + YAML.dump(retryFeedback);
      return { outcome: "retry", input: retryInput };
    }
    // Exhausted retries → escalate
    return escalateToUser(ctx, validationAttempts, retryMax);
  }

  // on_fail: notify_user (default) or escalate_to_user → escalate immediately
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

/** on_done: mark step completed, dispatch based on resolved callback */
export function handleDone(
  ctx: CallbackContext,
  output: string,
  validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }>,
): CallbackResult {
  const cb = resolveCallback(ctx.agentName, "on_done");
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

  // Default "next_agent" → continue. Other actions can be added via overrides.
  if (cb.action === "notify_user") {
    // Override: notify instead of auto-continuing (still continues pipeline)
    ctx.broadcast(ctx.runId, {
      type: "step-notify",
      agent: ctx.agentName,
      step: ctx.stepIndex,
      emoji: ctx.agentEmoji,
      message: `${ctx.agentEmoji} ${ctx.agentName} completed.`,
    });
  }

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

// ── Output marker detection ─────────────────────────────────────────────────

const CHANGE_REQUEST_MARKER = "CHANGE_REQUEST:";
const PIPELINE_SUGGESTION_MARKER = "PIPELINE_SUGGESTION:";

/** Check if agent output contains a change request marker */
export function detectChangeRequest(output: string): string | null {
  const idx = output.indexOf(CHANGE_REQUEST_MARKER);
  if (idx === -1) return null;
  return output.slice(idx + CHANGE_REQUEST_MARKER.length).trim();
}

/** Check if agent output contains a pipeline suggestion marker */
export function detectPipelineSuggestion(output: string): string | null {
  const idx = output.indexOf(PIPELINE_SUGGESTION_MARKER);
  if (idx === -1) return null;
  return output.slice(idx + PIPELINE_SUGGESTION_MARKER.length).trim();
}

/** on_change_request: call_agent — agent requested changes, dispatch to target agent */
export async function handleChangeRequest(
  ctx: CallbackContext,
  changeContext: string,
): Promise<CallbackResult> {
  const cb = resolveCallback(ctx.agentName, "on_change_request");

  if (cb.action === "call_agent") {
    const targetAgent = cb.agent ?? "Assembler";
    db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
      .run(`Change request → ${targetAgent}: ${changeContext.slice(0, 200)}`, ctx.runId, ctx.stepIndex);
    ctx.broadcast(ctx.runId, {
      type: "step-change-request",
      agent: ctx.agentName,
      targetAgent,
      step: ctx.stepIndex,
      emoji: ctx.agentEmoji,
      context: changeContext,
    });
    return { outcome: "continue" };
  }

  if (cb.action === "notify_user" || cb.action === "pause_and_notify_user") {
    return escalateToUser(ctx, [], 0);
  }

  return { outcome: "noop" };
}

/** on_pipeline_suggestion: pause_and_notify_user — agent suggests pipeline changes */
export async function handlePipelineSuggestion(
  ctx: CallbackContext,
  suggestion: string,
): Promise<CallbackResult> {
  const cb = resolveCallback(ctx.agentName, "on_pipeline_suggestion");

  if (cb.action === "pause_and_notify_user") {
    db.prepare("UPDATE run_steps SET status = 'waiting_user' WHERE run_id = ? AND step_order = ?")
      .run(ctx.runId, ctx.stepIndex);
    db.prepare("UPDATE runs SET status = 'waiting_user' WHERE id = ?").run(ctx.runId);

    // Try to parse the suggestion as YAML/JSON to get structured data
    const parsed = parsePipelineSuggestion(suggestion);
    const displaySuggestion = parsed
      ? `Action: ${parsed.action}\nAgent: ${parsed.agent}\nReason: ${parsed.reason}`
      : suggestion;

    const question = `${ctx.agentEmoji} ${ctx.agentName} suggests pipeline changes:\n${displaySuggestion}\n\nApprove or dismiss?`;
    ctx.broadcast(ctx.runId, {
      type: "step-pipeline-suggestion",
      agent: ctx.agentName,
      step: ctx.stepIndex,
      emoji: ctx.agentEmoji,
      suggestion: displaySuggestion,
      question,
    });

    const reply = await new Promise<string>((resolve) => {
      ctx.pendingInputs.set(ctx.runId, {
        resolve,
        stepIndex: ctx.stepIndex,
        taskId: "",
        agentSlug: ctx.agentSlug,
        question,
      });
    });

    const approved = reply.toLowerCase().startsWith("approve");

    // Resume after user decision
    db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
      .run(`Pipeline suggestion ${approved ? "approved" : "dismissed"}: ${suggestion.slice(0, 200)}`, ctx.runId, ctx.stepIndex);
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(ctx.runId);

    ctx.broadcast(ctx.runId, {
      type: "step-completed",
      agent: ctx.agentName,
      step: ctx.stepIndex,
      emoji: ctx.agentEmoji,
      output: `Pipeline suggestion: ${reply}`,
    });

    // If approved and we have a valid parsed suggestion, modify the pipeline
    if (approved && parsed) {
      return { outcome: "modify_pipeline", suggestion: parsed };
    }

    return { outcome: "continue" };
  }

  if (cb.action === "notify_user") {
    return escalateToUser(ctx, [], 0);
  }

  return { outcome: "noop" };
}

/** Parse pipeline suggestion from raw text (YAML or JSON) */
function parsePipelineSuggestion(raw: string): PipelineSuggestion | null {
  try {
    const parsed = YAML.load(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && parsed.action && parsed.agent) {
      const action = String(parsed.action);
      if (["insert_after_current", "insert_before_next", "replace_next"].includes(action)) {
        return {
          action: action as PipelineSuggestion["action"],
          agent: String(parsed.agent),
          reason: String(parsed.reason ?? ""),
        };
      }
    }
  } catch { /* not valid YAML — try JSON */ }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.action && parsed.agent) {
      const action = String(parsed.action);
      if (["insert_after_current", "insert_before_next", "replace_next"].includes(action)) {
        return {
          action: action as PipelineSuggestion["action"],
          agent: String(parsed.agent),
          reason: String(parsed.reason ?? ""),
        };
      }
    }
  } catch { /* not valid JSON either */ }

  return null;
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
