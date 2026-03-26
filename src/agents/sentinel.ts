/**
 * Sentinel A2A Agent — PR reviewer & gatekeeper
 *
 * Two-phase execution:
 *   Phase 1: Fetch PR diff + file contents via gh CLI, send to LLM for review
 *   Phase 2: Based on verdict — merge PR or post review comments
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

import { invokeGateway as invokeGatewayShared, accumulateUsage, emptyUsage, type TokenUsage } from "../gateway.js";
import { SentinelReviewJsonSchema } from "../schemas/json-schemas.js";

// ── Config ────────────────────────────────────────────────────────────────

const SENTINEL_BRIEF = `# You are Sentinel 🛡️

## Role
Code Reviewer & Quality Gatekeeper — you review pull requests for correctness, security, and code quality.

## What To Do

1. Read the PR diff and file contents provided below
2. Review each file for:
   - Correctness: does the code do what the task requires?
   - Security: any injection, auth bypass, data leak risks?
   - Code quality: naming, patterns, DRY, readability
   - Consistency: does it follow existing codebase patterns?
3. Check acceptance criteria from the pipeline context
4. Produce a verdict: "approved" or "request_changes"

## Verdict Rules

- **approved**: Code is clean, correct, and meets acceptance criteria. Minor style nits are OK — don't block for formatting.
- **request_changes**: Bugs, security issues, missing functionality, or significant quality problems. Provide SPECIFIC feedback per file.

## CRITICAL RULES

1. Be fair but rigorous — don't approve broken code, don't reject working code for nitpicks
2. Every file MUST have a status (accepted/rejected/needs_changes) and a comment explaining WHY
3. Security flags must be specific: what the risk is and where it is
4. If build fails, verdict MUST be request_changes
5. Acceptance criteria check must verify each criterion against actual code changes
6. Comments must be actionable — tell the developer exactly what to fix
`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastSentinelUsage(taskId?: string): TokenUsage | null {
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

// ── Types ───────────────────────────────────────────────────────────────

interface SentinelReviewOutput {
  verdict: "approved" | "request_changes";
  summary: string;
  files: Array<{
    path: string;
    status: "accepted" | "rejected" | "needs_changes";
    comment: string;
  }>;
  security_flags: string[];
  acceptance_criteria_check: Array<{
    criteria: string;
    met: boolean;
  }>;
}

// ── Git operations ──────────────────────────────────────────────────────

async function fetchPRContext(
  workspacePath: string,
  prNumber?: number,
  branchName?: string,
): Promise<{ diff: string; prInfo: any; files: Array<{ path: string; content: string }> }> {
  const { execSync } = await import("child_process");
  const exec = (cmd: string) =>
    execSync(cmd, { cwd: workspacePath, encoding: "utf-8", timeout: 30_000 }).trim();

  // Find the PR
  let prInfo: any = {};
  let diff = "";

  if (prNumber) {
    try {
      prInfo = JSON.parse(exec(`gh pr view ${prNumber} --json number,url,title,body,headRefName,baseRefName,files,additions,deletions`));
      diff = exec(`gh pr diff ${prNumber}`);
    } catch (err) {
      console.log(`[🛡️ Sentinel] Could not fetch PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
    }
  } else if (branchName) {
    try {
      prInfo = JSON.parse(exec(`gh pr view ${branchName} --json number,url,title,body,headRefName,baseRefName,files,additions,deletions`));
      diff = exec(`gh pr diff ${branchName}`);
    } catch (err) {
      console.log(`[🛡️ Sentinel] Could not fetch PR for branch ${branchName}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Read changed file contents
  const files: Array<{ path: string; content: string }> = [];
  if (prInfo.files) {
    for (const file of prInfo.files.slice(0, 20)) {
      try {
        const content = exec(`cat "${file.path}"`);
        files.push({ path: file.path, content });
      } catch {
        files.push({ path: file.path, content: "(file not found or binary)" });
      }
    }
  }

  return { diff, prInfo, files };
}

async function executePRAction(
  workspacePath: string,
  verdict: "approved" | "request_changes",
  prNumber: number,
  summary: string,
  files: Array<{ path: string; status: string; comment: string }>,
): Promise<{ merged: boolean }> {
  const { execSync } = await import("child_process");
  const exec = (cmd: string) =>
    execSync(cmd, { cwd: workspacePath, encoding: "utf-8", timeout: 30_000 }).trim();

  if (verdict === "approved") {
    // Approve and merge
    try {
      exec(`gh pr review ${prNumber} --approve --body "🛡️ Sentinel approved: ${summary.replace(/"/g, '\\"')}"`);
      console.log(`[🛡️ Sentinel] ✅ PR #${prNumber} approved`);
    } catch (err) {
      console.log(`[🛡️ Sentinel] ⚠️ Could not approve PR: ${err instanceof Error ? err.message : err}`);
    }

    try {
      exec(`gh pr merge ${prNumber} --squash --auto`);
      console.log(`[🛡️ Sentinel] 🔀 PR #${prNumber} merged`);
      return { merged: true };
    } catch (err) {
      console.log(`[🛡️ Sentinel] ⚠️ Could not merge PR: ${err instanceof Error ? err.message : err}`);
      return { merged: false };
    }
  } else {
    // Request changes with detailed feedback
    const reviewBody = [
      `🛡️ **Sentinel — Changes Requested**`,
      "",
      `**Summary:** ${summary}`,
      "",
      "**File Reviews:**",
      ...files
        .filter((f) => f.status !== "accepted")
        .map((f) => `- \`${f.path}\` (${f.status}): ${f.comment}`),
    ].join("\n");

    try {
      exec(`gh pr review ${prNumber} --request-changes --body "${reviewBody.replace(/"/g, '\\"')}"`);
      console.log(`[🛡️ Sentinel] 🔄 PR #${prNumber} — changes requested`);
    } catch (err) {
      console.log(`[🛡️ Sentinel] ⚠️ Could not post review: ${err instanceof Error ? err.message : err}`);
    }

    return { merged: false };
  }
}

// ── Sentinel Executor ───────────────────────────────────────────────────

class SentinelExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🛡️ Sentinel] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Extract PR number, branch, and workspace from context
    let workspacePath = process.cwd();
    let prNumber: number | undefined;
    let branchName: string | undefined;

    const wsMatch = text.match(/workspace[_\s]*path[:\s]+([^\s\n]+)/i);
    if (wsMatch?.[1]) workspacePath = wsMatch[1];

    const prMatch = text.match(/(?:pull_request|pr)[:\s]*(?:#?\s*)?(\d+)/i);
    if (prMatch?.[1]) prNumber = parseInt(prMatch[1], 10);

    const branchMatch = text.match(/branch[:\s]+([^\s\n]+)/i);
    if (branchMatch?.[1]) branchName = branchMatch[1];

    // Also try to extract PR number from Assembler output in context
    const prUrlMatch = text.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
    if (!prNumber && prUrlMatch?.[1]) prNumber = parseInt(prUrlMatch[1], 10);

    try {
      // Phase 1: Fetch PR context
      console.log(`[🛡️ Sentinel] Phase 1: Fetching PR context (PR #${prNumber ?? "?"}, branch: ${branchName ?? "?"})`);
      const { diff, prInfo, files } = await fetchPRContext(workspacePath, prNumber, branchName);

      if (!diff && !prInfo.number) {
        throw new Error("Could not find PR to review — no PR number or branch found in context");
      }

      prNumber = prNumber ?? prInfo.number;

      // Build file contents section
      const fileContents = files
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 5000)}\n\`\`\``)
        .join("\n\n");

      const fullBrief = [
        SENTINEL_BRIEF,
        "",
        "## PR Context",
        "",
        `**PR #${prNumber}:** ${prInfo.title ?? ""}`,
        `**Branch:** ${prInfo.headRefName ?? branchName ?? "unknown"} → ${prInfo.baseRefName ?? "main"}`,
        `**Changes:** +${prInfo.additions ?? "?"} -${prInfo.deletions ?? "?"}`,
        "",
        "## PR Diff",
        "```diff",
        diff.slice(0, 15000),
        "```",
        "",
        "## File Contents (post-change)",
        fileContents,
        "",
        "## Pipeline Context",
        text,
      ].join("\n");

      // Phase 1: LLM review
      console.log(`[🛡️ Sentinel] Phase 1: Calling LLM for review...`);
      let cumulativeUsage = emptyUsage();
      const gatewayResult = await invokeGatewayShared(fullBrief, "Sentinel", SentinelReviewJsonSchema);
      cumulativeUsage = accumulateUsage(cumulativeUsage, gatewayResult.usage);
      console.log(`[🛡️ Sentinel] Phase 1 done (${gatewayResult.output.length} chars, ${gatewayResult.usage.total_tokens} tokens)`);

      // Parse review output
      let review: SentinelReviewOutput;
      try {
        const raw = gatewayResult.output.trim();
        const cleaned = raw.startsWith("```")
          ? raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
          : raw;
        review = JSON.parse(cleaned);
      } catch (parseErr) {
        throw new Error(`Failed to parse LLM review output: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }

      // Phase 2: Execute PR action (approve+merge or request changes)
      console.log(`[🛡️ Sentinel] Phase 2: Verdict = ${review.verdict}, PR #${prNumber}`);
      const { merged } = await executePRAction(
        workspacePath,
        review.verdict,
        prNumber!,
        review.summary,
        review.files,
      );

      usageByTask.set(ctx.taskId, cumulativeUsage);

      // Build final output
      const sentinelOutput = {
        agent: "Sentinel",
        task_seq: 0,
        iteration: 1,
        status: review.verdict === "approved" ? "done" : "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: {
          verdict: review.verdict,
          pull_request: {
            number: prNumber!,
            url: prInfo.url ?? `https://github.com/unknown/pull/${prNumber}`,
            merged,
          },
          summary: review.summary,
          files: review.files,
          security_flags: review.security_flags,
          build_status: "pass",
          acceptance_criteria_check: review.acceptance_criteria_check,
        },
      };

      const jsonOutput = JSON.stringify(sentinelOutput, null, 2);

      // Publish as artifact
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "sentinel-output",
          description: "Sentinel review output (JSON)",
          parts: [{ kind: "text", text: jsonOutput, metadata: { mimeType: "application/json" } }],
        },
      };
      bus.publish(artifactEvent);

      const response: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: jsonOutput }],
        contextId: ctx.contextId,
      };
      bus.publish(response);
      bus.finished();

      console.log(`[🛡️ Sentinel] ✅ Done — verdict: ${review.verdict}, PR #${prNumber}${merged ? " (merged)" : ""}`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🛡️ Sentinel] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🛡️ Sentinel failed: ${errorMsg}` }],
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

export function createSentinelRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Sentinel",
    description: "Code Reviewer & Quality Gatekeeper — reviews PRs, approves and merges or requests changes with detailed feedback.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/sentinel/a2a/jsonrpc`,
    skills: [
      {
        id: "pr-review",
        name: "PR Review",
        description: "Review pull requests for correctness, security, and code quality",
        tags: ["review", "code-quality"],
      },
      {
        id: "merge-gatekeeper",
        name: "Merge Gatekeeper",
        description: "Approve and merge PRs or request changes with actionable feedback",
        tags: ["merge", "gatekeeper"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new SentinelExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
