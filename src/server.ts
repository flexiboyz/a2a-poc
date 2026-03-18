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
import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task } from "@a2a-js/sdk";
import db from "./db";

// ── Config ─────────────────────────────────────────────────────────────────

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

// ── Agent Definitions ──────────────────────────────────────────────────────

const AGENTS: AgentDef[] = [
  { name: "Spark", emoji: "✨", skill: "brainstorm", description: "Creative visionary — generates wild ideas" },
  { name: "Flint", emoji: "🪨", skill: "validate", description: "Pragmatic builder — validates feasibility", requiresInput: true },
  { name: "Ghost", emoji: "👻", skill: "critique", description: "Silent critic — finds hidden flaws" },
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
  const steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_order").all(req.params.id);
  const pending = pendingInputs.get(req.params.id);
  res.json({ ...run, steps, pendingInput: pending ? { step: pending.stepIndex, question: pending.question, agent: pending.agentSlug } : null });
});

// ── API: Reply to input-required ───────────────────────────────────────────

app.post("/api/runs/:id/reply", (req, res) => {
  const { reply } = req.body;
  const pending = pendingInputs.get(req.params.id);
  if (!pending) return res.status(404).json({ error: "No pending input for this run" });
  if (!reply) return res.status(400).json({ error: "reply is required" });

  console.log(`[orchestrator] User replied to run ${req.params.id}: "${reply.slice(0, 100)}"`);
  pending.resolve(reply);
  pendingInputs.delete(req.params.id);
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
  let previousOutput = "";

  for (let i = 0; i < agentNames.length; i++) {
    const agentName = agentNames[i];
    const agentDef = AGENTS.find((a) => a.name === agentName);
    if (!agentDef) throw new Error(`Unknown agent: ${agentName}`);

    const slug = agentName.toLowerCase();

    // Update step → running
    db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(runId, i);
    broadcast(runId, { type: "step-started", agent: agentName, step: i, emoji: agentDef.emoji });

    // Build chained prompt
    const chainedInput = previousOutput
      ? `## Original Topic\n${input}\n\n## Previous Agent Output\n${previousOutput}\n\n## Your Task\nBuild on the previous agent's work. You are step ${i + 1}/${agentNames.length}.`
      : `## Topic\n${input}\n\nYou are the first agent in the pipeline (step 1/${agentNames.length}).`;

    // Discover & call agent via A2A — same server, sub-path
    const cardUrl = `${BASE_URL}/${slug}/.well-known/agent-card.json`;
    const client = await A2AClient.fromCardUrl(cardUrl);
    const response = await client.sendMessage({
      message: {
        messageId: uuidv4(),
        role: "user",
        parts: [{ kind: "text", text: chainedInput }],
        kind: "message",
      },
    });

    // Check if response is a Task with input-required
    const result = (response as any).result ?? response;
    let output: string;

    if (result.kind === "task" && result.status?.state === "input-required") {
      // Agent needs user input!
      const question = result.status.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "Agent needs your input";
      const taskId = result.id;
      console.log(`[orchestrator] ${agentDef.emoji} ${agentName} requires input (task ${taskId})`);

      // Update step status
      db.prepare("UPDATE run_steps SET status = 'input-required' WHERE run_id = ? AND step_order = ?").run(runId, i);
      broadcast(runId, { type: "step-input-required", agent: agentName, step: i, emoji: agentDef.emoji, question });

      // Wait for user reply (blocks this pipeline execution)
      const userReply = await new Promise<string>((resolve) => {
        pendingInputs.set(runId, { resolve, stepIndex: i, taskId, agentSlug: slug, question });
      });

      // Resume the agent with user's reply
      console.log(`[orchestrator] Resuming ${agentName} with user reply`);
      db.prepare("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND step_order = ?").run(runId, i);
      broadcast(runId, { type: "step-resumed", agent: agentName, step: i, emoji: agentDef.emoji });

      const resumeResponse = await client.sendMessage({
        message: {
          messageId: uuidv4(),
          role: "user",
          parts: [{ kind: "text", text: userReply }],
          kind: "message",
          taskId, // Resume the same task!
        },
      });

      const resumeResult = (resumeResponse as any).result ?? resumeResponse;
      output = resumeResult.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
        || resumeResult.status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("")
        || "(no output)";
    } else {
      // Normal completion
      output = result.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "(no output)";
    }

    previousOutput = output;

    // Update step → completed
    db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(output, runId, i);
    broadcast(runId, { type: "step-completed", agent: agentName, step: i, emoji: agentDef.emoji, output });
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
