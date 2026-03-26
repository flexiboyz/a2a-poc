/**
 * Bastion A2A Agent — Security Auditor
 *
 * Deep security review of code changes and codebase.
 * Reads PR diffs, file contents, and scans for vulnerabilities.
 * Runs on Opus 4.6 for maximum depth.
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
import { BastionReviewJsonSchema } from "../schemas/json-schemas.js";

// ── Config ────────────────────────────────────────────────────────────────

const BASTION_BRIEF = `# You are Bastion 🏰

## Role
Security Auditor — you perform deep security reviews of codebases and code changes.
You are the last line of defense before code goes to production.

## What To Do

1. Read ALL code provided (PR diffs, file contents, codebase structure)
2. Perform a comprehensive security audit covering:

### Authentication & Authorization
- Missing auth on endpoints
- Broken access controls (IDOR, privilege escalation)
- Token/session management issues (weak secrets, no rotation, no expiry)
- Auth bypass vectors

### Injection & Input Validation
- SQL injection (even with ORMs — parameterization issues)
- XSS (stored, reflected, DOM-based)
- Command injection (shell exec, child_process)
- Path traversal (file reads/writes with user input)
- SSRF (server-side request forgery)

### Data Security
- Sensitive data exposure (keys, tokens, passwords in code/logs)
- Missing encryption (at rest, in transit)
- PII leakage
- Insecure direct object references

### API Security
- Rate limiting gaps
- Missing CORS configuration
- Exposed debug endpoints
- Mass assignment vulnerabilities
- Missing input validation/sanitization

### Infrastructure
- Insecure defaults (debug mode, verbose errors in prod)
- Missing security headers (CSP, HSTS, X-Frame-Options)
- Dependency vulnerabilities (known CVEs)
- Container/deployment misconfigurations

### Business Logic
- Race conditions (TOCTOU)
- Double-spend / double-execution risks
- Integer overflow/underflow in financial calculations
- Missing idempotency on critical operations

3. Rate each finding by severity: none, low, medium, high, critical
4. Provide SPECIFIC, ACTIONABLE recommendations — not vague advice

## CRITICAL RULES

1. Be thorough — missed security issues cost real money and data
2. Every finding must have: what the issue is, where it is (file + line if possible), why it matters, how to fix it
3. Don't report false positives — verify before flagging
4. Don't ignore "minor" issues that chain into critical exploits
5. If the codebase handles money, payments, or tokens — apply EXTRA scrutiny
6. Check for secrets/keys in code — this is always critical
7. Rate "none" only when you've actively verified something is secure, not when you haven't checked
`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastBastionUsage(taskId?: string): TokenUsage | null {
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

// ── Bastion Executor ────────────────────────────────────────────────────

class BastionExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🏰 Bastion] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Extract workspace path from context
    let workspacePath = process.cwd();
    const wsMatch = text.match(/workspace[_\s]*path[:\s]+([^\s\n]+)/i);
    if (wsMatch?.[1]) workspacePath = wsMatch[1];

    // Try to find and read PR diff
    let prContext = "";
    try {
      const { execSync } = await import("child_process");
      const exec = (cmd: string) =>
        execSync(cmd, { cwd: workspacePath, encoding: "utf-8", timeout: 30_000 }).trim();

      // Find open PR
      const prUrlMatch = text.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
      const branchMatch = text.match(/branch[:\s]+([^\s\n]+)/i);

      if (prUrlMatch?.[1]) {
        const prNum = prUrlMatch[1];
        const diff = exec(`gh pr diff ${prNum}`);
        const prInfo = JSON.parse(exec(`gh pr view ${prNum} --json files,additions,deletions,title`));
        prContext = `\n\n## PR #${prNum}: ${prInfo.title}\n+${prInfo.additions} -${prInfo.deletions}\n\n\`\`\`diff\n${diff.slice(0, 20000)}\n\`\`\`\n`;

        // Read changed files fully
        if (prInfo.files) {
          for (const file of prInfo.files.slice(0, 25)) {
            try {
              const content = exec(`cat "${file.path}"`);
              prContext += `\n### ${file.path}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\`\n`;
            } catch { /* file might be deleted */ }
          }
        }
      } else if (branchMatch?.[1]) {
        try {
          const diff = exec(`gh pr diff ${branchMatch[1]}`);
          prContext = `\n\n## PR diff (branch: ${branchMatch[1]})\n\`\`\`diff\n${diff.slice(0, 20000)}\n\`\`\`\n`;
        } catch { /* no PR for this branch */ }
      }
    } catch {
      console.log("[🏰 Bastion] Could not fetch PR context — will review from pipeline context only");
    }

    // Scan codebase structure
    let codebaseContext = "";
    try {
      const { execSync } = await import("child_process");
      const tree = execSync(
        `find ${workspacePath}/src ${workspacePath}/app ${workspacePath}/api 2>/dev/null -type f \\( -name "*.ts" -o -name "*.tsx" \\) | grep -v node_modules | grep -v .next | sort | head -50`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      codebaseContext = `\n\n## Codebase Structure\n\`\`\`\n${tree}\n\`\`\`\n`;

      // Read security-sensitive files
      const sensitivePatterns = ["auth", "login", "token", "session", "payout", "payment", "upload", "stream", "middleware"];
      for (const pattern of sensitivePatterns) {
        try {
          const files = execSync(
            `find ${workspacePath} -type f -name "*${pattern}*" \\( -name "*.ts" -o -name "*.tsx" \\) | grep -v node_modules | grep -v .next | head -3`,
            { encoding: "utf-8", timeout: 3000 },
          ).trim();
          for (const filePath of files.split("\n").filter(Boolean)) {
            try {
              const content = execSync(`cat "${filePath}"`, { encoding: "utf-8", timeout: 3000 });
              codebaseContext += `\n### ${filePath.replace(workspacePath, "")}\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\`\n`;
            } catch { /* skip */ }
          }
        } catch { /* no matches */ }
      }

      // Check for .env files (but don't read values — just check structure)
      try {
        const envFiles = execSync(`find ${workspacePath} -maxdepth 2 -name ".env*" -not -path "*/node_modules/*" | head -5`, { encoding: "utf-8", timeout: 2000 }).trim();
        if (envFiles) {
          codebaseContext += `\n### Environment files found\n${envFiles}\n`;
          // Check if .env is gitignored
          try {
            execSync(`cd ${workspacePath} && git check-ignore .env`, { encoding: "utf-8" });
            codebaseContext += `✅ .env is gitignored\n`;
          } catch {
            codebaseContext += `⚠️ .env may NOT be gitignored!\n`;
          }
        }
      } catch { /* skip */ }
    } catch { /* no codebase */ }

    const fullBrief = `${BASTION_BRIEF}${codebaseContext}${prContext}\n\n## Pipeline Context\n\n${text}`;

    try {
      console.log(`[🏰 Bastion] Calling LLM for security review...`);
      let cumulativeUsage = emptyUsage();
      const gatewayResult = await invokeGatewayShared(fullBrief, "Bastion", BastionReviewJsonSchema);
      cumulativeUsage = accumulateUsage(cumulativeUsage, gatewayResult.usage);
      console.log(`[🏰 Bastion] Done (${gatewayResult.output.length} chars, ${gatewayResult.usage.total_tokens} tokens)`);

      let review: any;
      try {
        const raw = gatewayResult.output.trim();
        const cleaned = raw.startsWith("```")
          ? raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
          : raw;
        review = JSON.parse(cleaned);
      } catch (parseErr) {
        throw new Error(`Failed to parse security review: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }

      usageByTask.set(ctx.taskId, cumulativeUsage);

      const bastionOutput = {
        agent: "Bastion",
        task_seq: 0,
        iteration: 1,
        status: "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: review,
      };

      const jsonOutput = JSON.stringify(bastionOutput, null, 2);

      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "bastion-output",
          description: "Bastion security review (JSON)",
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

      const criticalCount = review.security_review?.filter((r: any) => r.risk === "critical").length ?? 0;
      const highCount = review.security_review?.filter((r: any) => r.risk === "high").length ?? 0;
      console.log(`[🏰 Bastion] ✅ Done — ${review.security_review?.length ?? 0} findings (${criticalCount} critical, ${highCount} high)`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🏰 Bastion] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🏰 Bastion failed: ${errorMsg}` }],
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

export function createBastionRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Bastion",
    description: "Security Auditor — deep security review of codebases and PRs. Auth, injection, data leaks, infra, business logic.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/bastion/a2a/jsonrpc`,
    skills: [
      {
        id: "security-audit",
        name: "Security Audit",
        description: "Comprehensive security review covering OWASP Top 10, auth, injection, data security",
        tags: ["security", "audit", "owasp"],
      },
      {
        id: "pr-security-review",
        name: "PR Security Review",
        description: "Security-focused code review of pull requests",
        tags: ["security", "review", "pr"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new BastionExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
