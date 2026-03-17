/**
 * A2A Agent Server — minimal POC
 * 
 * Exposes an agent that:
 * 1. Receives a task via JSON-RPC
 * 2. Transitions: submitted → working → completed (or input-required → working → completed)
 * 3. Simulates work with a delay
 */

import express from "express";
import {
  AgentCard,
  AgentExecutor,
  DefaultRequestHandler,
  A2AExpressApp,
  InMemoryTaskStore,
  type RequestContext,
  type TaskContext,
} from "@a2a-js/sdk/server";

const PORT = 4000;

// ── Agent Card (discovery metadata) ────────────────────────────────────────

const agentCard: AgentCard = {
  name: "poc-agent",
  description: "A2A proof-of-concept agent — echoes tasks with state transitions",
  url: `http://localhost:${PORT}`,
  protocolVersion: "0.3.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  skills: [
    {
      id: "analyze",
      name: "Analyze",
      description: "Analyzes a topic and produces a short report",
    },
  ],
};

// ── Agent Executor (the actual logic) ──────────────────────────────────────

class PocAgentExecutor implements AgentExecutor {
  async execute(context: TaskContext): Promise<void> {
    const message = context.userMessage;
    const text = message.parts?.map((p: any) => p.text).join(" ") ?? "(no input)";

    console.log(`[agent] Received task: "${text}"`);

    // Transition to working
    await context.updateStatus("working", "Analyzing topic...");
    console.log(`[agent] → working`);

    // Simulate work (2 seconds)
    await sleep(2000);

    // Optional: simulate input-required for tasks containing "?"
    if (text.includes("?")) {
      console.log(`[agent] → input-required (question detected)`);
      await context.updateStatus("input-required", "I need clarification. Can you provide more details?");
      
      // Wait for user input (the framework handles this)
      const reply = await context.waitForInput();
      const replyText = reply.parts?.map((p: any) => p.text).join(" ") ?? "(no reply)";
      console.log(`[agent] Got user input: "${replyText}"`);
      
      await context.updateStatus("working", "Resuming with clarification...");
      await sleep(1000);
    }

    // Complete with an artifact
    await context.addArtifact({
      parts: [
        {
          type: "text",
          text: `## Analysis Report\n\nTopic: ${text}\n\nConclusion: This is a POC demonstrating A2A task lifecycle transitions.\n\nStates visited: submitted → working${text.includes("?") ? " → input-required → working" : ""} → completed`,
        },
      ],
    });

    await context.updateStatus("completed", "Analysis complete");
    console.log(`[agent] → completed ✅`);
  }
}

// ── Server Setup ───────────────────────────────────────────────────────────

const app = express();
const taskStore = new InMemoryTaskStore();
const executor = new PocAgentExecutor();
const handler = new DefaultRequestHandler(agentCard, taskStore, executor);
const a2aApp = new A2AExpressApp(handler);

a2aApp.setupRoutes(app);

app.listen(PORT, () => {
  console.log(`[a2a-server] Agent running on http://localhost:${PORT}`);
  console.log(`[a2a-server] Agent card: http://localhost:${PORT}/.well-known/agent-card.json`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
