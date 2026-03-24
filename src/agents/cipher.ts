/**
 * Cipher A2A Agent — Codebase analyst & implementation planner
 *
 * Standalone router (not using createAgentRouter factory) because the executor
 * wraps a real ACP Claude call via OpenClaw Gateway instead of simulated work.
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { AgentCard, Message, AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { Task, TaskArtifactUpdateEvent } from "@a2a-js/sdk";
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

// ── Config ────────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// Cipher's system brief — combines SHARED_RULES + role-specific instructions
const CIPHER_BRIEF = `# You are Cipher 🔐

## Role
Data & Systems Analyst — investigates structure, dependencies, and data flows.

## What To Do

1. Read the task context provided below
2. Analyze the task requirements against the current codebase
3. Produce a structured analysis:
   - **Summary**: what needs to be done
   - **Files impacted**: list with explanation
   - **Risks**: severity + description
   - **Dependencies**: what depends on what
   - **Recommendations**: ordered implementation steps
   - **Acceptance criteria check**: verify against pipeline criteria

## CRITICAL RULES

1. NEVER hallucinate — if info is missing, say so explicitly
2. Focus ONLY on the analysis objective
3. Be structured and precise — your output feeds the next agent
`;

// ── Gateway invocation ────────────────────────────────────────────────────

async function invokeGateway(task: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tool: "sessions_spawn",
        args: {
          runtime: "acp",
          agentId: "claude",
          mode: "run",
          task,
          runTimeoutSeconds: 300,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json() as Record<string, any>;
    // Extract the agent's output from the Gateway response
    const result = data?.["result"]?.["details"] ?? data?.["result"] ?? data;
    if (typeof result === "string") return result;
    return JSON.stringify(result, null, 2);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Gateway invocation timed out (120s)");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Cipher Executor ───────────────────────────────────────────────────────

class CipherExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🔐 Cipher] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Build the full brief for ACP Claude
    const fullBrief = `${CIPHER_BRIEF}\n\n## Task Context\n\n${text}`;

    try {
      console.log(`[🔐 Cipher] Calling ACP Claude via Gateway...`);
      const output = await invokeGateway(fullBrief);
      console.log(`[🔐 Cipher] → completed ✅ (${output.length} chars)`);

      // Publish YAML output as A2A artifact with proper mime type (§9.3)
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "cipher-output",
          description: "Cipher analysis output (YAML)",
          parts: [{ kind: "text", text: output, metadata: { mimeType: "application/x-yaml" } }],
        },
      };
      bus.publish(artifactEvent);

      const response: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: output }],
        contextId: ctx.contextId,
      };

      bus.publish(response);
      bus.finished();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🔐 Cipher] ❌ Failed:`, errorMsg);

      const task: Task = {
        kind: "task",
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: "failed",
          message: {
            kind: "message",
            messageId: uuidv4(),
            role: "agent",
            parts: [{ kind: "text", text: `🔐 Cipher failed: ${errorMsg}` }],
            contextId: ctx.contextId,
          },
          timestamp: new Date().toISOString(),
        },
        history: [],
      };

      bus.publish(task);
      bus.finished();
    }
  }

  cancelTask = async () => {};
}

// ── Router factory ────────────────────────────────────────────────────────

export function createCipherRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Cipher",
    description: "Data & Systems Analyst — investigates structure, dependencies, and data flows. Produces implementation plans.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/cipher/a2a/jsonrpc`,
    skills: [
      {
        id: "codebase-analysis",
        name: "Codebase Analysis",
        description: "Analyze codebase structure, dependencies, and data flows",
        tags: ["analysis", "code"],
      },
      {
        id: "implementation-plan",
        name: "Implementation Plan",
        description: "Produce detailed implementation plans with files, risks, and steps",
        tags: ["planning", "architecture"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new CipherExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
