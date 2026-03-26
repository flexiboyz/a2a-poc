import "dotenv/config";

/**
 * A2A POC — Single Express server + 3 agents + orchestrator + UI
 *
 * All agents share one server on port 4000:
 *   /spark/.well-known/agent-card.json   → Spark agent card
 *   /spark/a2a/jsonrpc                   → Spark JSON-RPC
 *   /flint/...                           → Flint (requires user input!)
 *   /ghost/...                           → Ghost
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { dispatchWebhookEvent } from "./webhook/dispatcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createAgentRouter } from "./agents/create-agent";
import type { AgentDef } from "./agents/create-agent";
import { createCipherRouter, getLastCipherUsage } from "./agents/cipher";
import { createAssemblerRouter, getLastAssemblerUsage } from "./agents/assembler";
import { createSentinelRouter, getLastSentinelUsage } from "./agents/sentinel";
import { createBastionRouter, getLastBastionUsage } from "./agents/bastion";
import { createPrismRouter, getLastPrismUsage } from "./agents/prism";
import { createMoodboardRouter, getLastMoodboardUsage } from "./agents/moodboard";
import { createWorkflowMasterRouter, getLastWorkflowMasterUsage } from "./agents/workflowmaster";
import { emptyUsage, type TokenUsage } from "./gateway";
import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task } from "@a2a-js/sdk";
import { sendMessageStream } from "./a2a/client";
import db from "./db";
import { validate } from "./a2a/validator";
import { buildPipelineContext, formatPipelineContextYaml } from "./a2a/spawner";
import YAML from "js-yaml";
import {
  type CallbackContext,
  type PipelineSuggestion,
  getMaxRetries,
  handleAgentFail,
  handleValidationFail,
  handleAwaitUser,
  handleDone,
  handleChangeRequest,
  handlePipelineSuggestion,
  detectChangeRequest,
  detectPipelineSuggestion,
  abortPipeline,
  resumeStep,
  handleGroupComplete,
  handleGroupPartialFail,
} from "./a2a/callback-handler";
import {
  type PipelineStep,
  type AgentResult,
  type GroupResult,
  type NormalizedGroup,
  normalizePipeline,
  mergeGroupOutputs,
  resolveGroupStatus,
  finalizeGroup,
  getTotalStepCount,
  getAllAgentNames,
} from "./a2a/parallel";
import { startConfigWatcher, stopConfigWatcher } from "./a2a/config-watcher.js";
import { resolveTemplate, listTemplates } from "./a2a/template-loader";

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

// ── Agent Definitions ──────────────────────────────────────────────────────

const AGENTS: AgentDef[] = [
  // Real ACP Claude agents — produce YAML validated by Zod
  { name: "WorkflowMaster", emoji: "🏃", skill: "orchestration", description: "Qualifies tasks, defines pipeline — YAML output" },
  { name: "Cipher", emoji: "🔍", skill: "analysis", description: "Codebase analysis — YAML output validated by Zod" },
  { name: "Assembler", emoji: "⚙️", skill: "implementation", description: "Implementation — writes code, creates branches, opens PRs" },
  { name: "Sentinel", emoji: "🛡️", skill: "review", description: "Code review — reviews PRs, approves/merges or requests changes" },
  { name: "Bastion", emoji: "🏰", skill: "security", description: "Security audit — deep OWASP review, auth, injection, data leaks" },
  { name: "Prism", emoji: "🌈", skill: "design", description: "UX design — mockups, component specs, user flows, image-gen prompts" },
  { name: "Moodboard", emoji: "🎨", skill: "moodboard", description: "Visual inspiration — upload images, get structured moodboard", requiresInput: true },
  // Toy agents for testing
  { name: "Spark", emoji: "✨", skill: "brainstorm", description: "Creative visionary — generates wild ideas" },
  { name: "Flint", emoji: "🪨", skill: "validate", description: "Pragmatic builder — validates feasibility", requiresInput: true },
  { name: "Ghost", emoji: "👻", skill: "critique", description: "Silent critic — finds hidden flaws" },
  { name: "Glitch", emoji: "💀", skill: "chaos", description: "Chaos agent — 50% chance of failure", alwaysFails: 0.5 },
  { name: "Loop", emoji: "🔁", skill: "rerun", description: "Checkpoint — asks to re-run the pipeline", askRerun: true },
  { name: "Fork", emoji: "🔀", skill: "branch", description: "Decision point — routes to different agents", branches: {
    question: "Which approach do you want for this topic?",
    a: { label: "Creative deep-dive", agents: ["Spark", "Ghost"] },
    b: { label: "Pragmatic validation", agents: ["Flint", "Glitch"] },
  }},
];

// ── Single Express App ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, "../public")));

// Mount toy agents on their sub-paths (skip real ACP agents — they have their own routers)
const REAL_AGENTS = new Set(["WorkflowMaster", "Cipher", "Assembler", "Sentinel", "Bastion", "Prism", "Moodboard"]);
for (const def of AGENTS) {
  if (REAL_AGENTS.has(def.name)) continue; // mounted separately below
  const slug = def.name.toLowerCase();
  const router = createAgentRouter(def, BASE_URL);
  app.use(`/${slug}`, router);
  console.log(`[🤖] Mounted ${def.emoji} ${def.name} → /${slug}/${def.requiresInput ? " (requires input)" : ""}`);
}

// Mount Cipher (real ACP Claude agent)
app.use("/cipher", createCipherRouter(BASE_URL));
console.log(`[🤖] Mounted 🔐 Cipher → /cipher/ (ACP Claude)`);

// Mount Assembler (real ACP agent — LLM + git operations)
app.use("/assembler", createAssemblerRouter(BASE_URL));
console.log(`[🤖] Mounted ⚙️ Assembler → /assembler/ (ACP + Git)`);

// Mount Sentinel (real ACP agent — PR review + merge/request changes)
app.use("/sentinel", createSentinelRouter(BASE_URL));
console.log(`[🤖] Mounted 🛡️ Sentinel → /sentinel/ (ACP + Git)`);

// Mount Bastion (security auditor — Opus 4.6)
app.use("/bastion", createBastionRouter(BASE_URL));
console.log(`[🤖] Mounted 🏰 Bastion → /bastion/ (Security Audit)`);

// Mount Prism (UX designer — mockups + image-gen prompts)
app.use("/prism", createPrismRouter(BASE_URL));
console.log(`[🤖] Mounted 🌈 Prism → /prism/ (UX Design)`);

// Mount Moodboard (visual inspiration — pauses for image upload)
app.use("/moodboard", createMoodboardRouter(BASE_URL));
console.log(`[🤖] Mounted 🎨 Moodboard → /moodboard/ (Visual Inspiration)`);

// Mount WorkflowMaster (real ACP Claude agent)
app.use("/workflowmaster", createWorkflowMasterRouter(BASE_URL));
console.log(`[🤖] Mounted 🏗️ WorkflowMaster → /workflowmaster/ (ACP Claude)`);

// SSE clients for live updates
const sseClients = new Map<string, express.Response[]>();

function broadcast(runId: string, data: any) {
  const clients = sseClients.get(runId) ?? [];
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Dispatch to webhook subscribers (fire-and-forget, non-blocking)
  try {
    const eventType = data?.type as string | undefined;
    if (eventType) {
      dispatchWebhookEvent(runId, eventType, data);
    }
  } catch {
    // Webhook failures must never break the pipeline
  }
}

// Track runs waiting for user input: runId → { resolve, stepIndex, taskId, agentSlug }
const pendingInputs = new Map<string, {
  resolve: (reply: string) => void;
  stepIndex: number;
  taskId: string;
  agentSlug: string;
  question: string;
  isEscalation?: boolean;
}>();

// ── API: List all runs ────────────────────────────────────────────────────

app.get("/api/runs", (_req, res) => {
  const rows = db.prepare(`
    SELECT
      r.id, r.pipeline_id, r.status, r.input, r.created_at,
      p.name as pipeline_name,
      (SELECT COUNT(*) FROM run_steps WHERE run_id = r.id) as step_count,
      (SELECT MIN(started_at) FROM run_steps WHERE run_id = r.id AND started_at IS NOT NULL) as started_at,
      (SELECT MAX(ended_at) FROM run_steps WHERE run_id = r.id AND ended_at IS NOT NULL) as ended_at,
      (SELECT GROUP_CONCAT(agent_name, ',') FROM run_steps WHERE run_id = r.id ORDER BY step_order) as agents
    FROM runs r
    LEFT JOIN pipelines p ON r.pipeline_id = p.id
    ORDER BY r.created_at DESC
  `).all() as any[];

  res.json(rows.map(r => ({
    ...r,
    agents: r.agents ? r.agents.split(",") : [],
    duration_ms: r.started_at && r.ended_at
      ? new Date(r.ended_at + "Z").getTime() - new Date(r.started_at + "Z").getTime()
      : null,
  })));
});

// ── API: Pipeline metrics ─────────────────────────────────────────────────

app.get("/api/metrics", (_req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
    FROM runs
  `).get() as any;

  const durations = db.prepare(`
    SELECT r.id,
      (SELECT MIN(started_at) FROM run_steps WHERE run_id = r.id AND started_at IS NOT NULL) as started,
      (SELECT MAX(ended_at) FROM run_steps WHERE run_id = r.id AND ended_at IS NOT NULL) as ended
    FROM runs r
    WHERE r.status = 'completed'
  `).all() as any[];

  const durationMs = durations
    .filter(d => d.started && d.ended)
    .map(d => new Date(d.ended + "Z").getTime() - new Date(d.started + "Z").getTime());
  const avgDuration = durationMs.length > 0
    ? Math.round(durationMs.reduce((a, b) => a + b, 0) / durationMs.length)
    : null;

  const failurePoints = db.prepare(`
    SELECT agent_name, COUNT(*) as fail_count
    FROM run_steps
    WHERE status = 'failed'
    GROUP BY agent_name
    ORDER BY fail_count DESC
    LIMIT 5
  `).all() as any[];

  const retryStats = db.prepare(`
    SELECT agent_name, SUM(attempt) as total_retries, COUNT(*) as step_count
    FROM run_steps
    WHERE attempt > 1
    GROUP BY agent_name
    ORDER BY total_retries DESC
    LIMIT 5
  `).all() as any[];

  res.json({
    total_runs: totals.total,
    completed: totals.completed,
    failed: totals.failed,
    running: totals.running,
    success_rate: totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0,
    avg_duration_ms: avgDuration,
    failure_points: failurePoints,
    retry_stats: retryStats,
  });
});

// ── API: List available agents ─────────────────────────────────────────────

app.get("/api/agents", (_req, res) => {
  // Import AGENT_MODELS from gateway to show current model per agent
  const AGENT_MODELS: Record<string, string> = {
    WorkflowMaster: process.env["MODEL_WORKFLOWMASTER"] ?? "google/gemini-2.5-flash",
    Cipher:         process.env["MODEL_CIPHER"] ?? "google/gemini-2.5-pro",
    Assembler:      process.env["MODEL_ASSEMBLER"] ?? "google/gemini-2.5-pro",
    Sentinel:       process.env["MODEL_SENTINEL"] ?? "google/gemini-2.5-pro",
    Hammer:         process.env["MODEL_HAMMER"] ?? "google/gemini-2.5-flash",
    Prism:          process.env["MODEL_PRISM"] ?? "google/gemini-2.5-flash",
    Bastion:        process.env["MODEL_BASTION"] ?? "google/gemini-2.5-flash",
    default:        process.env["MODEL_DEFAULT"] ?? "google/gemini-2.5-flash",
  };

  res.json(AGENTS.map((a) => {
    const slug = a.name.toLowerCase();
    const model = AGENT_MODELS[a.name] ?? AGENT_MODELS["default"] ?? "google/gemini-2.5-flash";
    return {
      name: a.name,
      emoji: a.emoji,
      skill: a.skill,
      description: a.description,
      model: model.split("/").pop(), // Short name (e.g. "gemini-2.5-pro")
      modelFull: model,              // Full id (e.g. "google/gemini-2.5-pro")
      requiresInput: a.requiresInput ?? false,
      cardUrl: `${BASE_URL}/${slug}/.well-known/agent-card.json`,
    };
  }));
});

// ── API: Projects ─────────────────────────────────────────────────────────

import { readFileSync } from "fs";

let _projectsCache: any[] | null = null;
function getProjects(): any[] {
  if (!_projectsCache) {
    _projectsCache = JSON.parse(readFileSync(resolve(__dirname, "../data/projects.json"), "utf-8"));
  }
  return _projectsCache!;
}

app.get("/api/projects", (_req, res) => {
  res.json(getProjects());
});

// ── API: Pipeline Templates ───────────────────────────────────────────────

app.get("/api/templates", (_req, res) => {
  try {
    res.json(listTemplates());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── API: Pipeline CRUD ─────────────────────────────────────────────────────

app.post("/api/pipelines", (req, res) => {
  const { name, agents, template_name } = req.body;

  if (template_name) {
    const template = resolveTemplate(template_name);
    if (!template) {
      return res.status(400).json({ error: `Unknown template: ${template_name}` });
    }
    const id = uuidv4();
    const pipelineName = name || `${template_name} Pipeline`;
    const pipelineAgents = template.agents;
    db.prepare("INSERT INTO pipelines (id, name, agents, template_name) VALUES (?, ?, ?, ?)")
      .run(id, pipelineName, JSON.stringify(pipelineAgents), template_name);
    return res.json({
      id,
      name: pipelineName,
      agents: pipelineAgents,
      template_name,
      default_prompt: template.default_prompt,
    });
  }

  const id = uuidv4();
  db.prepare("INSERT INTO pipelines (id, name, agents) VALUES (?, ?, ?)").run(id, name || "Untitled", JSON.stringify(agents));
  res.json({ id, name, agents });
});

app.get("/api/pipelines", (_req, res) => {
  const rows = db.prepare("SELECT * FROM pipelines ORDER BY created_at DESC").all() as any[];
  res.json(rows.map((r) => ({ ...r, agents: JSON.parse(r.agents) })));
});

// ── API: Run a pipeline ────────────────────────────────────────────────────

app.post("/api/pipelines/:id/run", async (req, res) => {
  const pipeline = db.prepare("SELECT * FROM pipelines WHERE id = ?").get(req.params.id) as any;
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  const steps: PipelineStep[] = JSON.parse(pipeline.agents);
  const runId = uuidv4();
  const input = req.body.input ?? "Analyze this topic";

  // Create run
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(runId, pipeline.id, input);

  // Create steps (handles both flat strings and group objects)
  const agentNames = createStepsForPipeline(runId, steps);

  res.json({ runId, status: "running", agents: agentNames });

  // Execute pipeline in background
  executePipeline(runId, steps, input).catch((err) => {
    console.error(`[orchestrator] Pipeline ${runId} failed:`, err);
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    broadcast(runId, { type: "pipeline-failed", error: err.message });
  });
});

// ── API: Get run status ────────────────────────────────────────────────────

app.get("/api/runs/:id", (req, res) => {
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: "Run not found" });
  const steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order").all(req.params.id) as any[];
  const pending = pendingInputs.get(req.params.id);
  res.json({
    ...run,
    replay_of: run.replay_of ?? null,
    replay_from_step: run.replay_from_step ?? null,
    steps: steps.map(s => ({ ...s, validation_errors: s.validation_errors ? JSON.parse(s.validation_errors) : null, input_tokens: s.input_tokens, output_tokens: s.output_tokens, total_tokens: s.total_tokens, estimated_cost: s.estimated_cost, retry_token_overhead: s.retry_token_overhead })),
    pendingInput: pending ? { step: pending.stepIndex, question: pending.question, agent: pending.agentSlug, isEscalation: pending.isEscalation ?? false } : null,
  });
});

// ── API: Reply to input-required ───────────────────────────────────────────

app.post("/api/runs/:id/reply", async (req, res) => {
  const { reply } = req.body;
  const pending = pendingInputs.get(req.params.id);
  if (!pending) return res.status(404).json({ error: "No pending input for this run" });
  if (!reply) return res.status(400).json({ error: "reply is required" });

  const runId = req.params.id;
  console.log(`[orchestrator] User replied to run ${runId}: "${reply.slice(0, 100)}"`);

  // Check if this is a rerun request from Loop agent
  const agentDef = AGENTS.find(a => a.name.toLowerCase() === pending.agentSlug);
  const isRerunAgent = agentDef?.askRerun;
  const wantsRerun = isRerunAgent && reply.toLowerCase().trim().startsWith("yes");

  pending.resolve(reply);
  pendingInputs.delete(runId);

  if (wantsRerun) {
    // Get original pipeline info to rerun
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as any;
    const pipeline = db.prepare("SELECT * FROM pipelines WHERE id = ?").get(run?.pipeline_id) as any;
    if (pipeline) {
      const steps: PipelineStep[] = JSON.parse(pipeline.agents);
      const newRunId = uuidv4();
      db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(newRunId, pipeline.id, run.input);
      const agentNames = createStepsForPipeline(newRunId, steps);
      res.json({ ok: true, rerun: true, newRunId, agents: agentNames });
      // Broadcast rerun event to old run's SSE
      broadcast(runId, { type: "pipeline-rerun", newRunId });
      // Execute new pipeline
      executePipeline(newRunId, steps, run.input).catch((err) => {
        console.error(`[orchestrator] Rerun pipeline ${newRunId} failed:`, err);
        db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(newRunId);
        broadcast(newRunId, { type: "pipeline-failed", error: err.message });
      });
      return;
    }
  }

  res.json({ ok: true });
});

// ── API: Replay a completed run ───────────────────────────────────────────

app.post("/api/runs/:id/replay", async (req, res) => {
  const originalRun = db.prepare("SELECT * FROM runs WHERE id = ?").get(req.params.id) as any;
  if (!originalRun) return res.status(404).json({ error: "Run not found" });
  if (originalRun.status === "running") return res.status(400).json({ error: "Cannot replay a running pipeline" });

  const pipeline = db.prepare("SELECT * FROM pipelines WHERE id = ?").get(originalRun.pipeline_id) as any;
  if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

  const steps: PipelineStep[] = JSON.parse(pipeline.agents);
  const allAgentNames = getAllAgentNames(normalizePipeline(steps));
  const fromStep = typeof req.body.from_step === "number" ? Math.max(0, Math.min(req.body.from_step, allAgentNames.length - 1)) : 0;
  const input = req.body.input ?? originalRun.input;

  const runId = uuidv4();
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input, replay_of, replay_from_step) VALUES (?, ?, 'running', ?, ?, ?)").run(runId, pipeline.id, input, req.params.id, fromStep);

  // Copy completed steps from original run (steps before fromStep)
  if (fromStep > 0) {
    const originalSteps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? AND step_order < ? ORDER BY step_order").all(req.params.id, fromStep) as any[];
    for (const step of originalSteps) {
      db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status, output, started_at, ended_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)").run(uuidv4(), runId, step.agent_name, step.step_order, step.output, step.started_at, step.ended_at);
    }
  }

  // Create pending steps for remaining agents
  for (let i = fromStep; i < allAgentNames.length; i++) {
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, allAgentNames[i], i);
  }

  res.json({ runId, status: "running", agents: allAgentNames, replayOf: req.params.id, fromStep });

  // Execute pipeline starting from fromStep
  executePipeline(runId, steps, input, fromStep).catch((err) => {
    console.error(`[orchestrator] Replay pipeline ${runId} failed:`, err);
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    broadcast(runId, { type: "pipeline-failed", error: err.message });
  });
});

// ── API: Backlog tickets ──────────────────────────────────────────────────

app.get("/api/runs/:id/backlog", (req, res) => {
  const tickets = db.prepare("SELECT * FROM backlog_tickets WHERE run_id = ? ORDER BY created_at").all(req.params.id);
  res.json(tickets);
});

// ── SSE: Live updates ──────────────────────────────────────────────────────

app.get("/api/runs/:id/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const runId = req.params.id;
  if (!sseClients.has(runId)) sseClients.set(runId, []);
  sseClients.get(runId)!.push(res);

  req.on("close", () => {
    const clients = sseClients.get(runId) ?? [];
    sseClients.set(runId, clients.filter((c) => c !== res));
  });
});

// ── Pipeline Modification ─────────────────────────────────────────────────

function applyPipelineModification(
  runId: string,
  currentStep: number,
  agentNames: string[],
  suggestion: PipelineSuggestion,
) {
  const { action, agent: newAgent } = suggestion;
  const agentDef = AGENTS.find(a => a.name === newAgent);

  console.log(`[orchestrator] Applying pipeline modification: ${action} agent=${newAgent} at step ${currentStep}`);

  if (action === "insert_after_current") {
    // Insert new agent right after current step
    const remaining = agentNames.slice(currentStep + 1);
    agentNames.splice(currentStep + 1, remaining.length, newAgent, ...remaining);

    // Insert new run_step
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(uuidv4(), runId, newAgent, currentStep + 1);

    // Shift remaining steps forward
    for (let j = 0; j < remaining.length; j++) {
      const oldOrder = currentStep + 1 + j;
      const newOrder = currentStep + 2 + j;
      db.prepare("UPDATE run_steps SET step_order = ? WHERE run_id = ? AND agent_name = ? AND step_order = ?")
        .run(newOrder, runId, remaining[j]!, oldOrder);
    }
  } else if (action === "insert_before_next") {
    // Same as insert_after_current (next step = currentStep + 1)
    const remaining = agentNames.slice(currentStep + 1);
    agentNames.splice(currentStep + 1, remaining.length, newAgent, ...remaining);

    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(uuidv4(), runId, newAgent, currentStep + 1);

    for (let j = 0; j < remaining.length; j++) {
      const oldOrder = currentStep + 1 + j;
      const newOrder = currentStep + 2 + j;
      db.prepare("UPDATE run_steps SET step_order = ? WHERE run_id = ? AND agent_name = ? AND step_order = ?")
        .run(newOrder, runId, remaining[j]!, oldOrder);
    }
  } else if (action === "replace_next") {
    // Replace the next agent in the pipeline
    const nextStep = currentStep + 1;
    if (nextStep < agentNames.length) {
      const replacedAgent = agentNames[nextStep];
      agentNames[nextStep] = newAgent;

      db.prepare("UPDATE run_steps SET agent_name = ? WHERE run_id = ? AND step_order = ?")
        .run(newAgent, runId, nextStep);

      console.log(`[orchestrator] Replaced ${replacedAgent} with ${newAgent} at step ${nextStep}`);
    }
  }

  broadcast(runId, {
    type: "pipeline-modified",
    action,
    agent: newAgent,
    emoji: agentDef?.emoji || "❓",
    step: currentStep,
    reason: suggestion.reason,
  });
}

// ── Out of Scope Processing ──────────────────────────────────────────────

function processOutOfScope(
  runId: string,
  agentName: string,
  stepOrder: number,
  output: string,
) {
  try {
    const parsed = YAML.load(output) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return;

    const outOfScope = parsed.out_of_scope;
    if (!Array.isArray(outOfScope) || outOfScope.length === 0) return;

    const insert = db.prepare(
      "INSERT INTO backlog_tickets (id, run_id, agent_name, step_order, title, description, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    for (const item of outOfScope) {
      if (!item || typeof item !== "object" || !item.title) continue;
      insert.run(
        uuidv4(),
        runId,
        agentName,
        stepOrder,
        String(item.title),
        String(item.description ?? ""),
        String(item.priority ?? "medium"),
      );
    }

    console.log(`[orchestrator] Created ${outOfScope.length} backlog ticket(s) from ${agentName} out_of_scope items`);

    broadcast(runId, {
      type: "out-of-scope-tickets",
      agent: agentName,
      step: stepOrder,
      count: outOfScope.length,
      items: outOfScope.map((item: any) => ({ title: item.title, priority: item.priority ?? "medium" })),
    });
  } catch {
    // Output not valid YAML or no out_of_scope — skip silently
  }
}

// ── Step Creation Helper ──────────────────────────────────────────────────

/**
 * Creates run_steps (and run_groups for multi-agent groups) from a PipelineStep[].
 * Returns the flat list of agent names for display purposes.
 */
function createStepsForPipeline(runId: string, steps: PipelineStep[]): string[] {
  const groups = normalizePipeline(steps);
  const allNames: string[] = [];
  let stepOrder = 0;

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx]!;

    if (group.agents.length > 1) {
      // Multi-agent group: create run_group + linked steps
      const groupId = uuidv4();
      db.prepare("INSERT INTO run_groups (id, run_id, group_order, failure_strategy, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(groupId, runId, gIdx, group.failureStrategy);

      for (let j = 0; j < group.agents.length; j++) {
        db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status, group_id, group_order) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
          .run(uuidv4(), runId, group.agents[j]!, stepOrder, groupId, j);
        allNames.push(group.agents[j]!);
        stepOrder++;
      }
    } else {
      // Single agent
      db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(uuidv4(), runId, group.agents[0]!, stepOrder);
      allNames.push(group.agents[0]!);
      stepOrder++;
    }
  }

  return allNames;
}

// ── Output Extraction (§9.3 — artifact-aware) ────────────────────────────

/**
 * Extracts agent output preferring A2A artifacts with mimeType metadata.
 * Falls back to message parts if no artifact found.
 */
function extractOutput(events: any[], result: any): string {
  // Check for artifact events with YAML mimeType
  for (const event of events) {
    if (event.kind === "artifact-update" && event.artifact?.parts) {
      for (const part of event.artifact.parts) {
        if (part.kind === "text" && part.metadata?.mimeType === "application/x-yaml") {
          return part.text;
        }
      }
    }
  }

  // Fallback: extract from artifact parts with any mimeType
  for (const event of events) {
    if (event.kind === "artifact-update" && event.artifact?.parts) {
      const text = event.artifact.parts
        .filter((p: any) => p.kind === "text")
        .map((p: any) => p.text)
        .join("");
      if (text) return text;
    }
  }

  // Fallback: extract from message/task parts
  return result.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
    || result.status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
    || "(no output)";
}

// ── Single Agent Executor ──────────────────────────────────────────────────

/**
 * Execute a single agent within a pipeline run.
 * When groupId is set, failures return a failed AgentResult instead of escalating/aborting,
 * and pipeline_suggestions are deferred (logged but not evaluated).
 */
async function executeAgent(
  runId: string,
  stepOrder: number,
  agentName: string,
  agentNames: string[],
  input: string,
  totalSteps: number,
  groupId?: string,
): Promise<AgentResult> {
  const agentDef = AGENTS.find((a) => a.name === agentName);
  if (!agentDef) throw new Error(`Unknown agent: ${agentName}`);

  const slug = agentName.toLowerCase();
  const maxAttempts = getMaxRetries(agentName);
  const inGroup = !!groupId;

  // Build callback context for this step
  const ctx: CallbackContext = {
    runId,
    stepIndex: stepOrder,
    agentName,
    agentEmoji: agentDef.emoji,
    agentSlug: slug,
    agentNames,
    groupId: groupId ?? null,
    broadcast,
    pendingInputs,
  };

  // Update step → running
  db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(runId, stepOrder);
  broadcast(runId, { type: "step-started", agent: agentName, step: stepOrder, emoji: agentDef.emoji });

  // Build accumulated context (§7)
  const pipelineContext = buildPipelineContext(runId, stepOrder, input, totalSteps);
  const contextYaml = formatPipelineContextYaml(pipelineContext);

  // Inject project registry so agents know workspace paths and repos
  const projectsContext = `## Available Projects\n\`\`\`json\n${JSON.stringify(getProjects(), null, 2)}\n\`\`\`\n\n`;

  const chainedInput = stepOrder === 0
    ? `${projectsContext}## Topic\n${input}\n\nYou are the first agent in the pipeline (step 1/${totalSteps}).`
    : `${projectsContext}## Pipeline Context\n\`\`\`yaml\n${contextYaml}\`\`\`\n\n## Your Task\nBuild on previous agents' work. You are step ${stepOrder + 1}/${totalSteps}.`;

  // Discover & call agent via A2A
  const cardUrl = `${BASE_URL}/${slug}/.well-known/agent-card.json`;
  const client = await A2AClient.fromCardUrl(cardUrl);

  // ── Retry loop (driven by callbacks) ──────────────────────────
  let output: string = "";
  let validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }> = [];
  let currentInput = chainedInput;
  let capturedPipelineSuggestion: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    db.prepare("UPDATE run_steps SET attempt = ? WHERE run_id = ? AND step_order = ?").run(attempt, runId, stepOrder);

    if (attempt > 1) {
      broadcast(runId, { type: "step-retry", agent: agentName, step: stepOrder, emoji: agentDef.emoji, attempt, maxAttempts });
    }

    const streamResult = await sendMessageStream(client, {
      message: {
        messageId: uuidv4(),
        role: "user",
        parts: [{ kind: "text", text: currentInput }],
        kind: "message",
      },
    });

    const result = streamResult.result as any;

    // ── on_fail: agent returned "failed" state ──
    if (result.kind === "task" && result.status?.state === "failed") {
      const errorMsg = result.status.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "Agent failed";
      console.log(`[orchestrator] ${agentDef.emoji} ${agentName} FAILED (attempt ${attempt}/${maxAttempts})`);

      if (inGroup) {
        // In a group: return failed result instead of escalating
        db.prepare("UPDATE run_steps SET status = 'failed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
          .run(errorMsg, runId, stepOrder);
        broadcast(runId, { type: "step-failed", agent: agentName, step: stepOrder, emoji: agentDef.emoji, output: errorMsg });
        return { agentName, status: "failed", output: errorMsg };
      }

      const cbResult = await handleAgentFail(ctx, errorMsg, attempt, maxAttempts, validationAttempts, chainedInput);

      if (cbResult.outcome === "retry") {
        currentInput = cbResult.input;
        console.log(`[orchestrator] Retrying ${agentName} (attempt ${attempt + 1}/${maxAttempts})`);
        continue;
      }
      if (cbResult.outcome === "abort") {
        abortPipeline(ctx, `Aborted by user after ${maxAttempts} failed attempts`);
        return { agentName, status: "failed", output: `Aborted after ${maxAttempts} failed attempts` };
      }
      if (cbResult.outcome === "fix") {
        output = cbResult.output;
        resumeStep(ctx);
        break;
      }
      if (cbResult.outcome === "reset") {
        resumeStep(ctx);
        validationAttempts = [];
        currentInput = chainedInput + (cbResult.input ? `\n\n## Additional Instructions\n${cbResult.input}` : "");
        attempt = 0;
        db.prepare("UPDATE run_steps SET attempt = 0 WHERE run_id = ? AND step_order = ?").run(runId, stepOrder);
        continue;
      }
    }

    // ── on_await_user: agent needs input ──
    if (result.kind === "task" && result.status?.state === "input-required") {
      const question = result.status.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "Agent needs your input";
      const taskId = result.id;
      console.log(`[orchestrator] ${agentDef.emoji} ${agentName} requires input (task ${taskId})`);

      const cbResult = await handleAwaitUser(ctx, question, taskId);

      if (cbResult.outcome === "wait_input") {
        const userReply = cbResult.userReply;

        // Check if this is a branching agent — inject branch agents into pipeline
        if (agentDef.branches) {
          const choice = userReply.trim().toLowerCase().startsWith("b") ? "b" : "a";
          const branch = agentDef.branches[choice];
          console.log(`[orchestrator] Fork: user chose ${choice.toUpperCase()} \u2192 ${branch.label} [${branch.agents.join(" \u2192 ")}]`);

          output = `\ud83d\udd00 Branch ${choice.toUpperCase()}: ${branch.label} \u2192 [${branch.agents.join(" \u2192 ")}]`;
          db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(output, runId, stepOrder);
          broadcast(runId, { type: "step-completed", agent: agentName, step: stepOrder, emoji: agentDef.emoji, output });

          const branchAgents = branch.agents;
          const remaining = agentNames.slice(stepOrder + 1);
          agentNames.splice(stepOrder + 1, remaining.length, ...branchAgents, ...remaining);

          for (let j = 0; j < branchAgents.length; j++) {
            const bStepOrder = stepOrder + 1 + j;
            db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, branchAgents[j]!, bStepOrder);
          }
          for (let j = 0; j < remaining.length; j++) {
            const oldOrder = stepOrder + 1 + j;
            const newOrder = stepOrder + 1 + branchAgents.length + j;
            db.prepare("UPDATE run_steps SET step_order = ? WHERE run_id = ? AND agent_name = ? AND step_order = ?").run(newOrder, runId, remaining[j]!, oldOrder);
          }

          broadcast(runId, {
            type: "pipeline-branched",
            choice: choice.toUpperCase(),
            label: branch.label,
            injectedAgents: branchAgents.map(name => {
              const def = AGENTS.find(a => a.name === name);
              return { name, emoji: def?.emoji || "\u2753" };
            }),
            step: stepOrder,
          });

          await new Promise(r => setTimeout(r, 200));
          break;
        }

        // Normal input-required: resume agent with user reply via SSE stream
        const resumeStreamResult = await sendMessageStream(client, {
          message: {
            messageId: uuidv4(),
            role: "user",
            parts: [{ kind: "text", text: userReply }],
            kind: "message",
            taskId: cbResult.taskId,
          },
        });

        const resumeResult = resumeStreamResult.result as any;
        output = resumeResult.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
          || (resumeResult as any).status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
          || "(no output)";
        break;
      }
    }

    // Normal completion — extract output from artifacts (§9.3) or message parts
    output = extractOutput(streamResult.events, result);

    // ── on_change_request: detect change request markers in output ──
    const changeRequestContext = detectChangeRequest(output);
    if (changeRequestContext) {
      console.log(`[orchestrator] ${agentDef.emoji} ${agentName} raised a change request`);
      const crResult = await handleChangeRequest(ctx, changeRequestContext);
      if (crResult.outcome === "continue") break;
      if (crResult.outcome === "noop") { /* fall through to validation */ }
    }

    // ── on_pipeline_suggestion: detect pipeline suggestion markers in output ──
    const pipelineSuggestionText = detectPipelineSuggestion(output);
    if (pipelineSuggestionText) {
      if (inGroup) {
        // In a group: defer pipeline suggestions — log but don't evaluate now
        console.log(`[orchestrator] ${agentDef.emoji} ${agentName} suggested pipeline changes (deferred — in group)`);
        capturedPipelineSuggestion = pipelineSuggestionText;
      } else {
        console.log(`[orchestrator] ${agentDef.emoji} ${agentName} suggested pipeline changes`);
        const psResult = await handlePipelineSuggestion(ctx, pipelineSuggestionText);
        if (psResult.outcome === "modify_pipeline") {
          applyPipelineModification(runId, stepOrder, agentNames, psResult.suggestion);
          break;
        }
        if (psResult.outcome === "continue") break;
        if (psResult.outcome === "noop") { /* fall through to validation */ }
      }
    }

    // ── on_validation_fail: validate output against agent schema ──
    const { agentSchemas } = await import("./schemas/index");
    if (agentSchemas[agentName]) {
      const validationResult = validate(agentName, output);
      if (!validationResult.success) {
        console.log(`[orchestrator] ${agentDef.emoji} ${agentName} validation failed (attempt ${attempt}/${maxAttempts})`);

        if (inGroup) {
          // In a group: return failed result instead of escalating
          db.prepare("UPDATE run_steps SET status = 'failed', output = ?, validation_errors = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
            .run(output, JSON.stringify([{ attempt, errors: validationResult.errors, raw: validationResult.raw }]), runId, stepOrder);
          broadcast(runId, { type: "step-failed", agent: agentName, step: stepOrder, emoji: agentDef.emoji, output: `Validation failed:\n${JSON.stringify(validationResult.errors, null, 2)}\n\n--- Raw output ---\n${output}` });
          return { agentName, status: "failed", output: `Validation failed: ${JSON.stringify(validationResult.errors)}` };
        }

        const cbResult = await handleValidationFail(ctx, validationResult, attempt, maxAttempts, validationAttempts, chainedInput);

        if (cbResult.outcome === "retry") {
          currentInput = cbResult.input;
          continue;
        }
        if (cbResult.outcome === "abort") {
          abortPipeline(ctx, `Aborted by user after ${maxAttempts} validation failures`);
          return { agentName, status: "failed", output: `Aborted after ${maxAttempts} validation failures` };
        }
        if (cbResult.outcome === "fix") {
          output = cbResult.output;
          resumeStep(ctx);
          break;
        }
        if (cbResult.outcome === "reset") {
          resumeStep(ctx);
          validationAttempts = [];
          currentInput = chainedInput + (cbResult.input ? `\n\n## Additional Instructions\n${cbResult.input}` : "");
          attempt = 0;
          db.prepare("UPDATE run_steps SET attempt = 0 WHERE run_id = ? AND step_order = ?").run(runId, stepOrder);
          continue;
        }
      }
    }

    // Validation passed (or no schema) — exit retry loop
    break;
  }

  // If we ended up in a branch, return completed with branch output
  if (agentDef.branches && output.startsWith("\ud83d\udd00")) {
    return { agentName, status: "completed", output, pipelineSuggestion: capturedPipelineSuggestion };
  }

  // ── out_of_scope: extract items and create backlog tickets ──
  processOutOfScope(runId, agentName, stepOrder, output);

  // ── on_done: mark step completed, proceed to next agent ──
  handleDone(ctx, output, validationAttempts);

  return { agentName, status: "completed", output, pipelineSuggestion: capturedPipelineSuggestion };
}

// ── Pipeline Orchestrator ──────────────────────────────────────────────────

async function executePipeline(runId: string, steps: PipelineStep[], input: string, startFrom = 0) {
  // Normalize pipeline: convert mixed PipelineStep[] to NormalizedGroup[]
  // For backward compatibility, a flat string[] becomes single-agent groups
  const groups = normalizePipeline(steps);
  const totalSteps = getTotalStepCount(groups);
  const allNames = getAllAgentNames(groups);

  // Calculate which step order we're starting from
  let stepOrder = 0;

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx]!;

    // Skip groups that are entirely before startFrom
    if (stepOrder + group.agents.length <= startFrom) {
      stepOrder += group.agents.length;
      continue;
    }

    if (group.agents.length === 1) {
      // ── Single-agent group: sequential execution (same as before) ──
      const agentName = group.agents[0]!;

      if (stepOrder < startFrom) {
        stepOrder++;
        continue;
      }

      const result = await executeAgent(runId, stepOrder, agentName, allNames, input, totalSteps);

      if (result.status === "failed") {
        // executeAgent already handled abort/fail for non-group agents
        return;
      }

      // Handle branching: the agentNames array may have been modified
      const agentDef = AGENTS.find((a) => a.name === agentName);
      if (agentDef?.branches && result.output.startsWith("\ud83d\udd00")) {
        // Re-normalize after branch injection — continue with updated agentNames
        // The agentNames array was mutated by executeAgent for branch injection
        stepOrder++;
        continue;
      }

      stepOrder++;
    } else {
      // ── Multi-agent group: parallel execution ──
      // Look up existing group_id from run_steps (created by createStepsForPipeline)
      const existingStep = db.prepare("SELECT group_id FROM run_steps WHERE run_id = ? AND step_order = ?").get(runId, stepOrder) as { group_id: string } | undefined;
      const groupId = existingStep?.group_id ?? uuidv4();

      // If no group record exists yet (e.g. SM pipeline or dynamic injection), create one
      const existingGroup = db.prepare("SELECT id FROM run_groups WHERE id = ?").get(groupId) as { id: string } | undefined;
      if (!existingGroup) {
        db.prepare("INSERT INTO run_groups (id, run_id, group_order, failure_strategy, status) VALUES (?, ?, ?, ?, 'running')")
          .run(groupId, runId, gIdx, group.failureStrategy);
        for (let j = 0; j < group.agents.length; j++) {
          db.prepare("UPDATE run_steps SET group_id = ?, group_order = ? WHERE run_id = ? AND step_order = ?")
            .run(groupId, j, runId, stepOrder + j);
        }
      } else {
        db.prepare("UPDATE run_groups SET status = 'running' WHERE id = ?").run(groupId);
      }

      console.log(`[orchestrator] Starting parallel group ${gIdx} [${group.agents.join(", ")}] (strategy: ${group.failureStrategy})`);
      broadcast(runId, {
        type: "group-started",
        groupOrder: gIdx,
        agents: group.agents,
        failureStrategy: group.failureStrategy,
      });

      // Run all agents in parallel
      const promises = group.agents.map((agentName, j) =>
        executeAgent(runId, stepOrder + j, agentName, allNames, input, totalSteps, groupId)
          .catch((err): AgentResult => ({
            agentName,
            status: "failed",
            output: err instanceof Error ? err.message : String(err),
          }))
      );

      const results = await Promise.allSettled(promises);
      const agentResults: AgentResult[] = results.map((r) =>
        r.status === "fulfilled" ? r.value : { agentName: "unknown", status: "failed" as const, output: String(r.reason) }
      );

      // Build GroupResult
      const deferredSuggestions = agentResults
        .filter((r) => r.pipelineSuggestion)
        .map((r) => ({ agentName: r.agentName, suggestion: r.pipelineSuggestion! }));

      const groupResult: GroupResult = {
        status: resolveGroupStatus(agentResults, group.failureStrategy),
        mergedOutput: mergeGroupOutputs(agentResults),
        results: agentResults,
        deferredSuggestions,
      };

      // Finalize group in DB
      finalizeGroup(groupId, groupResult.status, groupResult.mergedOutput);

      console.log(`[orchestrator] Group ${gIdx} completed: status=${groupResult.status}, ${agentResults.filter(r => r.status === "completed").length}/${agentResults.length} succeeded`);

      // Fire group callbacks via callback handler
      const groupCtx: CallbackContext = {
        runId,
        stepIndex: stepOrder,
        agentName: group.agents[0]!,
        agentEmoji: AGENTS.find(a => a.name === group.agents[0])?.emoji ?? "❓",
        agentSlug: group.agents[0]!.toLowerCase(),
        agentNames: allNames,
        groupId,
        broadcast,
        pendingInputs,
      };

      if (groupResult.status === "completed") {
        handleGroupComplete(groupCtx, group.agents, groupResult.mergedOutput);
      } else if (groupResult.status === "partial") {
        const failedAgents = agentResults.filter(r => r.status === "failed").map(r => r.agentName);
        handleGroupPartialFail(groupCtx, group.agents, failedAgents, groupResult.mergedOutput);
      }

      // Evaluate deferred pipeline suggestions at merge point
      if (groupResult.deferredSuggestions.length > 0) {
        console.log(`[orchestrator] Evaluating ${groupResult.deferredSuggestions.length} deferred pipeline suggestion(s) from group ${gIdx}`);
        for (const { agentName, suggestion } of groupResult.deferredSuggestions) {
          const agentDef = AGENTS.find((a) => a.name === agentName);
          const deferCtx: CallbackContext = {
            runId,
            stepIndex: stepOrder,
            agentName,
            agentEmoji: agentDef?.emoji ?? "❓",
            agentSlug: agentName.toLowerCase(),
            agentNames: allNames,
            groupId,
            broadcast,
            pendingInputs,
          };
          const psResult = await handlePipelineSuggestion(deferCtx, suggestion);
          if (psResult.outcome === "modify_pipeline") {
            applyPipelineModification(runId, stepOrder, allNames, psResult.suggestion);
            break; // Only apply one suggestion per group
          }
        }
      }

      // Handle group failure
      if (groupResult.status === "failed") {
        console.log(`[orchestrator] Group ${gIdx} failed with strategy '${group.failureStrategy}' — aborting pipeline`);
        db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
        broadcast(runId, { type: "pipeline-failed", error: `Parallel group ${gIdx} failed (all agents)` });
        return;
      }

      stepOrder += group.agents.length;
    }
  }

  // Pipeline done
  db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
  broadcast(runId, { type: "pipeline-completed" });
}

// ── API: Random pipeline ───────────────────────────────────────────────────

app.post("/api/random-run", async (req, res) => {
  const input = req.body.input ?? "Random pipeline test";

  // Pick random agents (exclude Loop — it goes at the end always)
  const pool = AGENTS.filter(a => !a.askRerun);
  const count = 2 + Math.floor(Math.random() * (pool.length - 1)); // 2 to pool.length agents
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, count).map(a => a.name);
  // Always add Loop at the end
  picked.push("Loop");

  const steps: PipelineStep[] = picked;
  const pipelineId = uuidv4();
  db.prepare("INSERT INTO pipelines (id, name, agents) VALUES (?, ?, ?)").run(pipelineId, "Random Pipeline", JSON.stringify(steps));

  const runId = uuidv4();
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(runId, pipelineId, input);
  createStepsForPipeline(runId, steps);

  res.json({ runId, pipelineId, status: "running", agents: picked });

  executePipeline(runId, steps, input).catch((err) => {
    console.error(`[orchestrator] Random pipeline ${runId} failed:`, err);
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    broadcast(runId, { type: "pipeline-failed", error: err.message });
  });
});

// ── API: SM-first pipeline run ──────────────────────────────────────────────

app.post("/api/sm-run", async (req, res) => {
  const input = req.body.input ?? "Analyze this topic";

  const runId = uuidv4();
  const pipelineId = uuidv4();

  // Create pipeline placeholder — agents TBD after SM runs
  db.prepare("INSERT INTO pipelines (id, name, agents) VALUES (?, ?, ?)").run(pipelineId, "SM Pipeline", JSON.stringify([]));
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(runId, pipelineId, input);

  // Step 0: WorkflowMaster
  db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, "WorkflowMaster", 0);

  res.json({ runId, pipelineId, status: "running", agents: ["WorkflowMaster", "..."] });

  // Execute SM-first pipeline in background
  executeSMPipeline(runId, pipelineId, input).catch((err) => {
    console.error(`[orchestrator] SM pipeline ${runId} failed:`, err);
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
    broadcast(runId, { type: "pipeline-failed", error: err.message });
  });
});

/**
 * SM-first pipeline: run WorkflowMaster as step 0, extract pipeline from output,
 * then execute the derived pipeline via executePipeline().
 */
async function executeSMPipeline(runId: string, pipelineId: string, input: string) {
  // ── Step 0: Run WorkflowMaster ────────────────────────────────────────
  db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = 0").run(runId);
  broadcast(runId, { type: "step-started", agent: "WorkflowMaster", step: 0, emoji: "🏗️" });

  const cardUrl = `${BASE_URL}/workflowmaster/.well-known/agent-card.json`;
  const client = await A2AClient.fromCardUrl(cardUrl);

  const smInput = `## Task\n${input}\n\nProduce a qualification and pipeline for this task.`;

  const streamResult = await sendMessageStream(client, {
    message: {
      messageId: uuidv4(),
      role: "user",
      parts: [{ kind: "text", text: smInput }],
      kind: "message",
    },
  });

  const result = streamResult.result as any;

  // Check for failure
  if (result.kind === "task" && result.status?.state === "failed") {
    const errorMsg = result.status.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "WorkflowMaster failed";
    db.prepare("UPDATE run_steps SET status = 'failed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = 0").run(errorMsg, runId);
    broadcast(runId, { type: "step-failed", agent: "WorkflowMaster", step: 0, emoji: "🏗️", output: errorMsg });
    throw new Error(`WorkflowMaster failed: ${errorMsg}`);
  }

  // Extract output (§9.3 — artifact-aware)
  const smOutput = extractOutput(streamResult.events, result);

  // Validate against WorkflowMaster schema
  const validationResult = validate("WorkflowMaster", smOutput);
  if (!validationResult.success) {
    const errors = JSON.stringify(validationResult.errors, null, 2);
    console.error(`[orchestrator] WorkflowMaster output validation failed:`, errors);
    db.prepare("UPDATE run_steps SET status = 'failed', output = ?, validation_errors = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = 0")
      .run(smOutput, errors, runId);
    broadcast(runId, { type: "step-failed", agent: "WorkflowMaster", step: 0, emoji: "🏗️", error: "Validation failed" });
    throw new Error(`WorkflowMaster output validation failed`);
  }

  // Parse validated output to extract pipeline (may contain groups)
  const parsed = YAML.load(smOutput) as any;
  const derivedSteps: PipelineStep[] = parsed.output.pipeline;
  const derivedAgentNames = getAllAgentNames(normalizePipeline(derivedSteps));

  console.log(`[orchestrator] SM derived pipeline: [${derivedAgentNames.join(" → ")}]`);

  // Mark SM step done + token usage
  const smTokenUsage = getLastWorkflowMasterUsage((result as any)?.id);
  if (smTokenUsage) {
    db.prepare(`UPDATE run_steps SET status = 'completed', output = ?,
      input_tokens = ?, output_tokens = ?, total_tokens = ?, estimated_cost = ?, retry_token_overhead = ?,
      ended_at = datetime('now') WHERE run_id = ? AND step_order = 0`)
      .run(smOutput, smTokenUsage.input_tokens, smTokenUsage.output_tokens,
        smTokenUsage.total_tokens, smTokenUsage.estimated_cost, smTokenUsage.retry_token_overhead ?? 0, runId);
  } else {
    db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = 0").run(smOutput, runId);
  }
  broadcast(runId, { type: "step-completed", agent: "WorkflowMaster", step: 0, emoji: "🏗️", output: smOutput,
    tokenUsage: smTokenUsage ? { input_tokens: smTokenUsage.input_tokens, output_tokens: smTokenUsage.output_tokens, total_tokens: smTokenUsage.total_tokens, estimated_cost: smTokenUsage.estimated_cost, is_estimated: smTokenUsage.is_estimated } : undefined });

  // ── Derive pipeline from SM output ────────────────────────────────────
  // Full pipeline = SM step + derived steps
  const fullSteps: PipelineStep[] = ["WorkflowMaster", ...derivedSteps];
  db.prepare("UPDATE pipelines SET agents = ? WHERE id = ?").run(JSON.stringify(fullSteps), pipelineId);

  // Create run_steps for derived agents (offset by 1 for SM step)
  const derivedGroups = normalizePipeline(derivedSteps);
  let derivedStepOrder = 1;
  for (let gIdx = 0; gIdx < derivedGroups.length; gIdx++) {
    const group = derivedGroups[gIdx]!;
    if (group.agents.length > 1) {
      const groupId = uuidv4();
      db.prepare("INSERT INTO run_groups (id, run_id, group_order, failure_strategy, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(groupId, runId, gIdx, group.failureStrategy);
      for (let j = 0; j < group.agents.length; j++) {
        db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status, group_id, group_order) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
          .run(uuidv4(), runId, group.agents[j]!, derivedStepOrder++, groupId, j);
      }
    } else {
      db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(uuidv4(), runId, group.agents[0]!, derivedStepOrder++);
    }
  }

  broadcast(runId, {
    type: "sm-pipeline-derived",
    agents: derivedAgentNames,
    qualification: parsed.output.qualification,
    acceptance_criteria: parsed.output.acceptance_criteria,
  });

  // ── Execute derived pipeline via executePipeline (starting from step 1) ──
  // executePipeline handles completion/failure status and broadcast
  await executePipeline(runId, fullSteps, input, 1);
}

// ── API: Cost tracking ───────────────────────────────────────────────────────

app.get("/api/runs/:id/costs", (req, res) => {
  const steps = db.prepare(`
    SELECT agent_name, step_order, input_tokens, output_tokens, total_tokens,
           estimated_cost, retry_token_overhead, attempt, status
    FROM run_steps WHERE run_id = ? ORDER BY step_order
  `).all(req.params.id) as any[];
  const totalCost = steps.reduce((sum: number, s: any) => sum + (s.estimated_cost ?? 0), 0);
  const totalTokens = steps.reduce((sum: number, s: any) => sum + (s.total_tokens ?? 0), 0);
  res.json({ run_id: req.params.id, total_cost: totalCost, total_tokens: totalTokens, steps });
});

app.get("/api/costs/summary", (_req, res) => {
  const byAgent = db.prepare(`
    SELECT agent_name,
      COUNT(*) as step_count,
      SUM(COALESCE(input_tokens, 0)) as total_input_tokens,
      SUM(COALESCE(output_tokens, 0)) as total_output_tokens,
      SUM(COALESCE(total_tokens, 0)) as total_tokens,
      SUM(COALESCE(estimated_cost, 0)) as total_cost,
      AVG(COALESCE(estimated_cost, 0)) as avg_cost_per_step
    FROM run_steps
    WHERE status = 'completed' AND total_tokens IS NOT NULL
    GROUP BY agent_name ORDER BY total_cost DESC
  `).all();

  const byPipeline = db.prepare(`
    SELECT r.pipeline_id, p.name as pipeline_name,
      COUNT(DISTINCT r.id) as run_count,
      SUM(COALESCE(rs.total_tokens, 0)) as total_tokens,
      SUM(COALESCE(rs.estimated_cost, 0)) as total_cost
    FROM run_steps rs
    JOIN runs r ON rs.run_id = r.id
    JOIN pipelines p ON r.pipeline_id = p.id
    WHERE rs.status = 'completed' AND rs.total_tokens IS NOT NULL
    GROUP BY r.pipeline_id ORDER BY total_cost DESC
  `).all();

  const totals = db.prepare(`
    SELECT
      SUM(COALESCE(total_tokens, 0)) as total_tokens,
      SUM(COALESCE(estimated_cost, 0)) as total_cost,
      COUNT(*) as tracked_steps
    FROM run_steps WHERE total_tokens IS NOT NULL
  `).get() as any;

  res.json({ totals, by_agent: byAgent, by_pipeline: byPipeline });
});

// ── Start ──────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n[🚀] A2A Pipeline Builder: http://localhost:${PORT}`);
  console.log(`[🚀] Caddy: http://rockeros.rockerone.io/a2a-poc/`);
  console.log(`\n[📋] Agent Cards:`);
  for (const a of AGENTS) {
    const slug = a.name.toLowerCase();
    console.log(`     ${a.emoji} ${a.name}: ${BASE_URL}/${slug}/.well-known/agent-card.json${a.requiresInput ? " ⏸️ (input-required)" : ""}`);
  }
  console.log();

  startConfigWatcher();
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown() {
  console.log("[shutdown] Shutting down...");
  stopConfigWatcher().then(() => {
    server.close(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
