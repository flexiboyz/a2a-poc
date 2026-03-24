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
import { invokeGateway as invokeGatewayShared, accumulateUsage, emptyUsage, type TokenUsage } from "../gateway.js";

// ── Config ────────────────────────────────────────────────────────────────



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

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastWorkflowMasterUsage(taskId?: string): TokenUsage | null {
  if (!taskId) {
    const first = usageByTask.entries().next();
    if (first.done) return null;
    usageByTask.delete(first.value[0]);
    return first.value[1];
  }
  const u = usageByTask.get(taskId) ?? null;
  usageByTask.delete(taskId);
  return u;
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
      let cumulativeUsage = emptyUsage();
      const gatewayResult = await invokeGatewayShared(fullBrief, "WorkflowMaster");
      const rawOutput = gatewayResult.output;
      cumulativeUsage = accumulateUsage(cumulativeUsage, gatewayResult.usage);
      console.log(`[🏗️ WorkflowMaster] → gateway done (${rawOutput.length} chars, ${gatewayResult.usage.total_tokens} tokens${gatewayResult.usage.is_estimated ? " est." : ""})`);

      // Self-validate output against Zod schema (§11.4)
      const { finalOutput: output, attempts, selfValidated } = await selfValidateOutput(
        "WorkflowMaster",
        rawOutput,
        async (feedback) => {
          const retryResult = await invokeGatewayShared(`${SM_BRIEF}\n\n${feedback}`, "WorkflowMaster");
          cumulativeUsage = accumulateUsage(cumulativeUsage, retryResult.usage);
          return retryResult.output;
        },
      );
      cumulativeUsage.retry_token_overhead = cumulativeUsage.total_tokens - gatewayResult.usage.total_tokens;
      usageByTask.set(ctx.taskId, cumulativeUsage);
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
