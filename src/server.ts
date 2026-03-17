/**
 * A2A POC — Main server + 3 agents + orchestrator + UI
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";
import { resolve } from "path";
import { createAgent } from "./agents/create-agent";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { Message } from "@a2a-js/sdk";
import db from "./db";

// ── Agent Definitions ──────────────────────────────────────────────────────

const AGENTS = [
  { name: "Spark", emoji: "✨", port: 4001, skill: "brainstorm", description: "Creative visionary — generates wild ideas" },
  { name: "Flint", emoji: "🪨", port: 4002, skill: "validate", description: "Pragmatic builder — validates feasibility" },
  { name: "Ghost", emoji: "👻", port: 4003, skill: "critique", description: "Silent critic — finds hidden flaws" },
];

// ── Start Agent Servers ────────────────────────────────────────────────────

for (const def of AGENTS) {
  const { app } = createAgent(def);
  app.listen(def.port, () => {
    console.log(`[${def.emoji}] ${def.name} agent on http://localhost:${def.port}`);
  });
}

// ── Main Server (UI + API) ─────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(resolve(__dirname, "../public")));

// SSE clients for live updates
const sseClients = new Map<string, express.Response[]>();

function broadcast(runId: string, data: any) {
  const clients = sseClients.get(runId) ?? [];
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ── API: List available agents ─────────────────────────────────────────────

app.get("/api/agents", (_req, res) => {
  res.json(AGENTS.map((a) => ({
    name: a.name,
    emoji: a.emoji,
    port: a.port,
    skill: a.skill,
    description: a.description,
    cardUrl: `http://localhost:${a.port}/.well-known/agent-card.json`,
  })));
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
  res.json({ ...run, steps });
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
  const factory = new ClientFactory();
  let previousOutput = ""; // Chain: each agent receives previous output

  for (let i = 0; i < agentNames.length; i++) {
    const agentName = agentNames[i];
    const agentDef = AGENTS.find((a) => a.name === agentName);
    if (!agentDef) throw new Error(`Unknown agent: ${agentName}`);

    // Update step → running
    db.prepare("UPDATE run_steps SET status = 'running', started_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(runId, i);
    broadcast(runId, { type: "step-started", agent: agentName, step: i, emoji: agentDef.emoji });

    // Build chained prompt
    const chainedInput = previousOutput
      ? `## Original Topic\n${input}\n\n## Previous Agent Output\n${previousOutput}\n\n## Your Task\nBuild on the previous agent's work. You are step ${i + 1}/${agentNames.length}.`
      : `## Topic\n${input}\n\nYou are the first agent in the pipeline (step 1/${agentNames.length}).`;

    // Discover & call agent via A2A
    const client = await factory.createFromUrl(`http://localhost:${agentDef.port}`);
    const response = await client.sendMessage({
      message: {
        messageId: uuidv4(),
        role: "user",
        parts: [{ kind: "text", text: chainedInput }],
        kind: "message",
      },
    });

    // Extract response text
    const msg = response as Message;
    const output = msg.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") ?? "(no output)";
    previousOutput = output; // Pass to next agent

    // Update step → completed
    db.prepare("UPDATE run_steps SET status = 'completed', output = ?, ended_at = datetime('now') WHERE run_id = ? AND step_order = ?").run(output, runId, i);
    broadcast(runId, { type: "step-completed", agent: agentName, step: i, emoji: agentDef.emoji, output });
  }

  // Pipeline done
  db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
  broadcast(runId, { type: "pipeline-completed" });
}

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`\n[🚀] Pipeline Builder UI: http://localhost:${PORT}`);
  console.log(`[🚀] Caddy: http://rockeros.rockerone.io/a2a-poc/\n`);
});
