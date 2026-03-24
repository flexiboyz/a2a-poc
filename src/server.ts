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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createAgentRouter } from "./agents/create-agent";
import type { AgentDef } from "./agents/create-agent";
import { createCipherRouter } from "./agents/cipher";
import { createWorkflowMasterRouter } from "./agents/workflowmaster";
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
} from "./a2a/callback-handler";
import { resolveTemplate, listTemplates } from "./a2a/template-loader";

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;
const FULL_CONTEXT_DEPTH = parseInt(process.env.FULL_CONTEXT_DEPTH ?? "1", 10);

// ── Agent Definitions ──────────────────────────────────────────────────────

const AGENTS: AgentDef[] = [
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

// Mount each agent on its sub-path
for (const def of AGENTS) {
  const slug = def.name.toLowerCase();
  const router = createAgentRouter(def, BASE_URL);
  app.use(`/${slug}`, router);
  console.log(`[🤖] Mounted ${def.emoji} ${def.name} → /${slug}/${def.requiresInput ? " (requires input)" : ""}`);
}

// Mount Cipher (real ACP Claude agent)
app.use("/cipher", createCipherRouter(BASE_URL));
console.log(`[🤖] Mounted 🔐 Cipher → /cipher/ (ACP Claude)`);

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

// ── API: List available agents ─────────────────────────────────────────────

app.get("/api/agents", (_req, res) => {
  res.json(AGENTS.map((a) => {
    const slug = a.name.toLowerCase();
    return {
      name: a.name,
      emoji: a.emoji,
      skill: a.skill,
      description: a.description,
      requiresInput: a.requiresInput ?? false,
      cardUrl: `${BASE_URL}/${slug}/.well-known/agent-card.json`,
    };
  }));
});

// ── API: Pipeline CRUD ─────────────────────────────────────────────────────

app.post("/api/pipelines", (req, res) => {
  const { name, agents } = req.body;
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

  const agents: string[] = JSON.parse(pipeline.agents);
  const runId = uuidv4();
  const input = req.body.input ?? "Analyze this topic";

  // Create run
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(runId, pipeline.id, input);

  // Create steps
  for (let i = 0; i < agents.length; i++) {
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, agents[i], i);
  }

  res.json({ runId, status: "running", agents });

  // Execute pipeline in background
  executePipeline(runId, agents, input).catch((err) => {
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
    steps: steps.map(s => ({ ...s, validation_errors: s.validation_errors ? JSON.parse(s.validation_errors) : null })),
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
      const agents: string[] = JSON.parse(pipeline.agents);
      const newRunId = uuidv4();
      db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(newRunId, pipeline.id, run.input);
      for (let i = 0; i < agents.length; i++) {
        db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), newRunId, agents[i], i);
      }
      res.json({ ok: true, rerun: true, newRunId, agents });
      // Broadcast rerun event to old run's SSE
      broadcast(runId, { type: "pipeline-rerun", newRunId });
      // Execute new pipeline
      executePipeline(newRunId, agents, run.input).catch((err) => {
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

  const agents: string[] = JSON.parse(pipeline.agents);
  const fromStep = typeof req.body.from_step === "number" ? Math.max(0, Math.min(req.body.from_step, agents.length - 1)) : 0;
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
  for (let i = fromStep; i < agents.length; i++) {
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, agents[i], i);
  }

  res.json({ runId, status: "running", agents, replayOf: req.params.id, fromStep });

  // Execute pipeline starting from fromStep
  executePipeline(runId, agents, input, fromStep).catch((err) => {
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

// ── Pipeline Orchestrator ──────────────────────────────────────────────────

async function executePipeline(runId: string, agentNames: string[], input: string, startFrom = 0) {
  for (let i = startFrom; i < agentNames.length; i++) {
    const agentName = agentNames[i]!;
    const agentDef = AGENTS.find((a) => a.name === agentName);
    if (!agentDef) throw new Error(`Unknown agent: ${agentName}`);

    const slug = agentName.toLowerCase();
    const maxAttempts = getMaxRetries(agentName);

    // Build callback context for this step
    const ctx: CallbackContext = {
      runId,
      stepIndex: i,
      agentName,
      agentEmoji: agentDef.emoji,
      agentSlug: slug,
      agentNames,
      broadcast,
      pendingInputs,
    };

    // Update step → running
    db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(runId, i);
    broadcast(runId, { type: "step-started", agent: agentName, step: i, emoji: agentDef.emoji });

    // Build accumulated context (§7)
    const pipelineContext = buildPipelineContext(runId, i, input, agentNames.length, 1, 3, FULL_CONTEXT_DEPTH);
    const contextYaml = formatPipelineContextYaml(pipelineContext);

    const chainedInput = i === 0
      ? `## Topic\n${input}\n\nYou are the first agent in the pipeline (step 1/${agentNames.length}).`
      : `## Pipeline Context\n\`\`\`yaml\n${contextYaml}\`\`\`\n\n## Your Task\nBuild on previous agents' work. You are step ${i + 1}/${agentNames.length}.`;

    // Discover & call agent via A2A
    const cardUrl = `${BASE_URL}/${slug}/.well-known/agent-card.json`;
    const client = await A2AClient.fromCardUrl(cardUrl);

    // ── Retry loop (driven by callbacks) ──────────────────────────
    let output: string = "";
    let validationAttempts: Array<{ attempt: number; errors: any[]; raw: string }> = [];
    let currentInput = chainedInput;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      db.prepare("UPDATE run_steps SET attempt = ? WHERE run_id = ? AND step_order = ?").run(attempt, runId, i);

      if (attempt > 1) {
        broadcast(runId, { type: "step-retry", agent: agentName, step: i, emoji: agentDef.emoji, attempt, maxAttempts });
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

        const cbResult = await handleAgentFail(ctx, errorMsg, attempt, maxAttempts, validationAttempts, chainedInput);

        if (cbResult.outcome === "retry") {
          currentInput = cbResult.input;
          console.log(`[orchestrator] Retrying ${agentName} (attempt ${attempt + 1}/${maxAttempts})`);
          continue;
        }
        if (cbResult.outcome === "abort") {
          abortPipeline(ctx, `Aborted by user after ${maxAttempts} failed attempts`);
          return;
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
          db.prepare("UPDATE run_steps SET attempt = 0 WHERE run_id = ? AND step_order = ?").run(runId, i);
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
            console.log(`[orchestrator] Fork: user chose ${choice.toUpperCase()} → ${branch.label} [${branch.agents.join(" → ")}]`);

            output = `🔀 Branch ${choice.toUpperCase()}: ${branch.label} → [${branch.agents.join(" → ")}]`;
            db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(output, runId, i);
            broadcast(runId, { type: "step-completed", agent: agentName, step: i, emoji: agentDef.emoji, output });

            const branchAgents = branch.agents;
            const remaining = agentNames.slice(i + 1);
            agentNames.splice(i + 1, remaining.length, ...branchAgents, ...remaining);

            for (let j = 0; j < branchAgents.length; j++) {
              const stepOrder = i + 1 + j;
              db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, branchAgents[j]!, stepOrder);
            }
            for (let j = 0; j < remaining.length; j++) {
              const oldOrder = i + 1 + j;
              const newOrder = i + 1 + branchAgents.length + j;
              db.prepare("UPDATE run_steps SET step_order = ? WHERE run_id = ? AND agent_name = ? AND step_order = ?").run(newOrder, runId, remaining[j]!, oldOrder);
            }

            broadcast(runId, {
              type: "pipeline-branched",
              choice: choice.toUpperCase(),
              label: branch.label,
              injectedAgents: branchAgents.map(name => {
                const def = AGENTS.find(a => a.name === name);
                return { name, emoji: def?.emoji || "❓" };
              }),
              step: i,
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
      const pipelineSuggestion = detectPipelineSuggestion(output);
      if (pipelineSuggestion) {
        console.log(`[orchestrator] ${agentDef.emoji} ${agentName} suggested pipeline changes`);
        const psResult = await handlePipelineSuggestion(ctx, pipelineSuggestion);
        if (psResult.outcome === "modify_pipeline") {
          applyPipelineModification(runId, i, agentNames, psResult.suggestion);
          break;
        }
        if (psResult.outcome === "continue") break;
        if (psResult.outcome === "noop") { /* fall through to validation */ }
      }

      // ── on_validation_fail: validate output against agent schema ──
      const { agentSchemas } = await import("./schemas/index");
      if (agentSchemas[agentName]) {
        const validationResult = validate(agentName, output);
        if (!validationResult.success) {
          console.log(`[orchestrator] ${agentDef.emoji} ${agentName} validation failed (attempt ${attempt}/${maxAttempts})`);

          const cbResult = await handleValidationFail(ctx, validationResult, attempt, maxAttempts, validationAttempts, chainedInput);

          if (cbResult.outcome === "retry") {
            currentInput = cbResult.input;
            continue;
          }
          if (cbResult.outcome === "abort") {
            abortPipeline(ctx, `Aborted by user after ${maxAttempts} validation failures`);
            return;
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
            db.prepare("UPDATE run_steps SET attempt = 0 WHERE run_id = ? AND step_order = ?").run(runId, i);
            continue;
          }
        }
      }

      // Validation passed (or no schema) — exit retry loop
      break;
    }

    // If we ended up in a branch, skip normal completion
    if (agentDef.branches && output.startsWith("🔀")) {
      continue;
    }

    // ── out_of_scope: extract items and create backlog tickets ──
    processOutOfScope(runId, agentName, i, output);

    // ── on_done: mark step completed, proceed to next agent ──
    handleDone(ctx, output, validationAttempts);
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

  const pipelineId = uuidv4();
  db.prepare("INSERT INTO pipelines (id, name, agents) VALUES (?, ?, ?)").run(pipelineId, "Random Pipeline", JSON.stringify(picked));

  const runId = uuidv4();
  db.prepare("INSERT INTO runs (id, pipeline_id, status, input) VALUES (?, ?, 'running', ?)").run(runId, pipelineId, input);
  for (let i = 0; i < picked.length; i++) {
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')").run(uuidv4(), runId, picked[i], i);
  }

  res.json({ runId, pipelineId, status: "running", agents: picked });

  executePipeline(runId, picked, input).catch((err) => {
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
    broadcast(runId, { type: "step-failed", agent: "WorkflowMaster", step: 0, emoji: "🏗️", error: errorMsg });
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

  // Parse validated output to extract pipeline
  const parsed = YAML.load(smOutput) as any;
  const derivedAgents: string[] = parsed.output.pipeline;

  console.log(`[orchestrator] SM derived pipeline: [${derivedAgents.join(" → ")}]`);

  // Mark SM step done
  db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = 0").run(smOutput, runId);
  broadcast(runId, { type: "step-completed", agent: "WorkflowMaster", step: 0, emoji: "🏗️", output: smOutput });

  // ── Derive pipeline from SM output ────────────────────────────────────
  // Update pipeline with derived agents (SM + derived)
  const allAgents = ["WorkflowMaster", ...derivedAgents];
  db.prepare("UPDATE pipelines SET agents = ? WHERE id = ?").run(JSON.stringify(allAgents), pipelineId);

  // Create run_steps for derived agents
  for (let i = 0; i < derivedAgents.length; i++) {
    db.prepare("INSERT INTO run_steps (id, run_id, agent_name, step_order, status) VALUES (?, ?, ?, ?, 'pending')")
      .run(uuidv4(), runId, derivedAgents[i], i + 1);
  }

  broadcast(runId, {
    type: "sm-pipeline-derived",
    agents: derivedAgents,
    qualification: parsed.output.qualification,
    acceptance_criteria: parsed.output.acceptance_criteria,
  });

  // ── Execute derived pipeline ──────────────────────────────────────────
  // Pass SM YAML as context to downstream agents
  const smContext = `## WorkflowMaster Output\n\`\`\`yaml\n${smOutput}\n\`\`\`\n\n## Original Task\n${input}`;

  // Re-use executePipeline but with offset step orders
  // We need to run the derived agents starting from step_order 1
  for (let i = 0; i < derivedAgents.length; i++) {
    const agentName = derivedAgents[i]!;
    const stepOrder = i + 1;
    const slug = agentName.toLowerCase();

    // Check if agent exists (simulated or real)
    const agentDef = AGENTS.find((a) => a.name === agentName);
    const isRealAgent = ["Cipher", "WorkflowMaster"].includes(agentName);

    if (!agentDef && !isRealAgent) {
      console.warn(`[orchestrator] Unknown agent in SM pipeline: ${agentName} — skipping`);
      db.prepare("UPDATE run_steps SET status = 'failed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
        .run(`Unknown agent: ${agentName}`, runId, stepOrder);
      broadcast(runId, { type: "step-failed", agent: agentName, step: stepOrder, emoji: "❓", error: `Unknown agent: ${agentName}` });
      continue;
    }

    db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(runId, stepOrder);
    broadcast(runId, { type: "step-started", agent: agentName, step: stepOrder, emoji: agentDef?.emoji ?? "🤖" });

    // Build context with SM output + accumulated pipeline context
    const pipelineContext = buildPipelineContext(runId, stepOrder, input, allAgents.length, 1, 3, FULL_CONTEXT_DEPTH);
    const contextYaml = formatPipelineContextYaml(pipelineContext);

    const agentInput = `## Pipeline Context\n\`\`\`yaml\n${contextYaml}\`\`\`\n\n## Your Task\nBuild on previous agents' work. You are step ${stepOrder + 1}/${allAgents.length}.`;

    try {
      const agentCardUrl = `${BASE_URL}/${slug}/.well-known/agent-card.json`;
      const agentClient = await A2AClient.fromCardUrl(agentCardUrl);

      const agentStreamResult = await sendMessageStream(agentClient, {
        message: {
          messageId: uuidv4(),
          role: "user",
          parts: [{ kind: "text", text: agentInput }],
          kind: "message",
        },
      });

      const agentResult = agentStreamResult.result as any;
      const output = extractOutput(agentStreamResult.events, agentResult);

      // Validate if schema exists
      const { agentSchemas } = await import("./schemas/index");
      if (agentSchemas[agentName]) {
        const valResult = validate(agentName, output);
        if (!valResult.success) {
          console.warn(`[orchestrator] ${agentName} validation failed in SM pipeline — continuing with raw output`);
        }
      }

      db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(output, runId, stepOrder);
      broadcast(runId, { type: "step-completed", agent: agentName, step: stepOrder, emoji: agentDef?.emoji ?? "🤖", output });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] SM pipeline agent ${agentName} failed:`, errorMsg);
      db.prepare("UPDATE run_steps SET status = 'failed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?")
        .run(errorMsg, runId, stepOrder);
      broadcast(runId, { type: "step-failed", agent: agentName, step: stepOrder, emoji: agentDef?.emoji ?? "🤖", error: errorMsg });
      // Continue to next agent — don't abort entire pipeline on single failure
    }
  }

  // Pipeline done
  db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
  broadcast(runId, { type: "pipeline-completed" });
}

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n[🚀] A2A Pipeline Builder: http://localhost:${PORT}`);
  console.log(`[🚀] Caddy: http://rockeros.rockerone.io/a2a-poc/`);
  console.log(`\n[📋] Agent Cards:`);
  for (const a of AGENTS) {
    const slug = a.name.toLowerCase();
    console.log(`     ${a.emoji} ${a.name}: ${BASE_URL}/${slug}/.well-known/agent-card.json${a.requiresInput ? " ⏸️ (input-required)" : ""}`);
  }
  console.log();
});
