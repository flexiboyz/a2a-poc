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
import { resolve } from "path";
import { createAgentRouter } from "./agents/create-agent";
import type { AgentDef } from "./agents/create-agent";
import { createCipherRouter } from "./agents/cipher";
import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task } from "@a2a-js/sdk";
import db from "./db";
import { validate } from "./a2a/validator";
import { buildPipelineContext, formatPipelineContextYaml } from "./a2a/spawner";
import {
  type CallbackContext,
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

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

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

// ── Pipeline Orchestrator ──────────────────────────────────────────────────

async function executePipeline(runId: string, agentNames: string[], input: string) {
  for (let i = 0; i < agentNames.length; i++) {
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
    const pipelineContext = buildPipelineContext(runId, i, input, agentNames.length);
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

      const response = await client.sendMessage({
        message: {
          messageId: uuidv4(),
          role: "user",
          parts: [{ kind: "text", text: currentInput }],
          kind: "message",
        },
      });

      const result = (response as any).result ?? response;

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

          // Normal input-required: resume agent with user reply
          const resumeResponse = await client.sendMessage({
            message: {
              messageId: uuidv4(),
              role: "user",
              parts: [{ kind: "text", text: userReply }],
              kind: "message",
              taskId: cbResult.taskId,
            },
          });

          const resumeResult = (resumeResponse as any).result ?? resumeResponse;
          output = resumeResult.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
            || resumeResult.status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
            || "(no output)";
          break;
        }
      }

      // Normal completion — extract output
      output = result.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "(no output)";

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
