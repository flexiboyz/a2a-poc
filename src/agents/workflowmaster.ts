/**
 * WorkflowMaster A2A Agent — Task qualification + pipeline definition
 *
 * Standalone router (like cipher.ts) — wraps ACP Claude via OpenClaw Gateway.
 * Produces Zod-validated YAML matching WorkflowMasterSchema.
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

import { selfValidateOutput } from "./self-validate.js";

// ── Config ────────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

const SM_BRIEF = `# You are WorkflowMaster (SM) 🏗️

## Role
Task qualifier and pipeline architect. You analyze incoming tasks and produce a structured qualification + ordered agent pipeline.

## What To Do

1. Read the task context provided below
2. Qualify the task: determine complexity, type, and estimated number of agents
3. Define an ordered pipeline of agents to execute the task
4. Specify the target branch and acceptance criteria

## Output Format

You MUST output valid YAML matching this exact structure (no markdown fences, just raw YAML):

agent: WorkflowMaster
task_seq: <task sequence number from context>
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  qualification:
    complexity: <low|medium|high>
    type: <code|design|legal|mixed>
    estimated_agents: <number>
  pipeline:
    - <AgentName1>
    - <AgentName2>
  branch: <target branch, e.g. "main">
  acceptance_criteria:
    - "<criterion 1>"
    - "<criterion 2>"
  context_notes: "<optional free text>"

## Available Agents
- Cipher: Data & Systems Analyst — codebase analysis, implementation plans
- Assembler: Senior Software Engineer — implementation
- Sentinel: Code reviewer — PR review, quality checks
- Prism: UX/Design — UI/UX analysis and recommendations
- Bastion: Infrastructure — deployment, CI/CD, infra changes
- Hammer: Testing — test writing and validation

## CRITICAL RULES

1. NEVER hallucinate — if info is missing, say so in context_notes
2. Output MUST be valid YAML — no markdown, no code fences
3. Pipeline MUST contain at least one agent
4. Pipeline order matters — agents execute sequentially
5. Always include Sentinel at the end for code/mixed tasks
`;

// ── Gateway invocation ────────────────────────────────────────────────────

async function invokeGateway(task: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

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

// ── WorkflowMaster Executor ──────────────────────────────────────────────

class WorkflowMasterExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🏗️ WorkflowMaster] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    const fullBrief = `${SM_BRIEF}\n\n## Task Context\n\n${text}`;

    try {
      console.log(`[🏗️ WorkflowMaster] Calling ACP Claude via Gateway...`);
      const rawOutput = await invokeGateway(fullBrief);
      console.log(`[🏗️ WorkflowMaster] → gateway done (${rawOutput.length} chars)`);

      // Self-validate output against Zod schema (§11.4)
      const { finalOutput: output, attempts, selfValidated } = await selfValidateOutput(
        "WorkflowMaster",
        rawOutput,
        (feedback) => invokeGateway(`${SM_BRIEF}\n\n${feedback}`),
      );
      if (attempts > 0) {
        console.log(`[🏗️ WorkflowMaster] Self-validation: ${selfValidated ? "passed" : "failed"} after ${attempts} attempt(s)`);
      }

      // Publish YAML output as A2A artifact with proper mime type (§9.3)
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "workflowmaster-output",
          description: "WorkflowMaster qualification output (YAML)",
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
      console.error(`[🏗️ WorkflowMaster] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🏗️ WorkflowMaster failed: ${errorMsg}` }],
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

export function createWorkflowMasterRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "WorkflowMaster",
    description: "Task qualifier and pipeline architect — analyzes tasks, determines complexity, and defines ordered agent pipelines.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/workflowmaster/a2a/jsonrpc`,
    skills: [
      {
        id: "task-qualification",
        name: "Task Qualification",
        description: "Qualify tasks by complexity, type, and required agents",
        tags: ["qualification", "planning"],
      },
      {
        id: "pipeline-definition",
        name: "Pipeline Definition",
        description: "Define ordered agent pipelines with acceptance criteria",
        tags: ["pipeline", "orchestration"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new WorkflowMasterExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
