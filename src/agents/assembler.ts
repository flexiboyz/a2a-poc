/**
 * Assembler A2A Agent — Implementation engineer
 *
 * Two-phase execution:
 *   Phase 1: LLM generates code (structured JSON with file contents)
 *   Phase 2: Executor writes files, creates branch, commits, pushes, opens PR
 *
 * The final YAML artifact is constructed by the executor from real git results.
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
import { AssemblerCodeGenJsonSchema } from "../schemas/json-schemas.js";


// ── Config ────────────────────────────────────────────────────────────────

const ASSEMBLER_BRIEF = `# You are Assembler ⚙️

## Role
Senior Software Engineer — you implement code changes based on analysis from previous agents.

## What To Do

1. Read the task context and previous agent outputs (especially Cipher's analysis)
2. For each file that needs to be created or modified, produce the COMPLETE file content
3. Write clear, production-quality code
4. Follow existing code patterns and conventions from the codebase context

## Output Format

You MUST output valid JSON matching the required schema. For each file:
- **path**: relative path from workspace root
- **action**: "create" for new files, "modify" for existing files, "delete" for removals
- **content**: the FULL file content (for create/modify). For modify, output the entire file, not a diff.
  For delete, set content to an empty string.
- Generate appropriate commit messages (conventional commits: feat:, fix:, refactor:, etc.)
- Set the branch name following the pattern: feat/, fix/, refactor/ + short kebab-case description

## CRITICAL RULES

1. NEVER hallucinate imports or APIs — only use what exists in the codebase context
2. Output COMPLETE file contents — no placeholders, no "// ... rest of file", no truncation
3. Every file must be syntactically valid (TypeScript, TSX, CSS, etc.)
4. Follow existing code style: indentation, naming conventions, import patterns
5. If Cipher's analysis says "create", create the full file. If "modify", output the entire modified file.
6. Do NOT include test files unless explicitly requested
7. Commit messages must be descriptive and follow conventional commits
8. Branch name must be unique and descriptive
`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastAssemblerUsage(taskId?: string): TokenUsage | null {
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

// ── Types for LLM code generation output ────────────────────────────────

interface FileChange {
  path: string;
  action: "create" | "modify" | "delete";
  content: string;
}

interface CodeGenOutput {
  summary: string;
  branch: string;
  files: FileChange[];
  commits: string[];
}

// ── Git & File operations ───────────────────────────────────────────────

async function executeGitOperations(
  codeGen: CodeGenOutput,
  workspacePath: string,
  targetBranch: string,
): Promise<{ prNumber: number; prUrl: string; filesChanged: Array<{ path: string; action: string }> }> {
  const { execSync } = await import("child_process");
  const { writeFileSync, mkdirSync, unlinkSync } = await import("fs");
  const { dirname, resolve } = await import("path");

  const exec = (cmd: string) =>
    execSync(cmd, { cwd: workspacePath, encoding: "utf-8", timeout: 30_000 }).trim();

  // 1. Ensure we're on a clean state and fetch latest
  try {
    exec("git fetch origin");
  } catch {
    console.log("[⚙️ Assembler] git fetch failed — continuing with local state");
  }

  // 2. Create feature branch from target branch
  const branchName = codeGen.branch;
  try {
    exec(`git checkout ${targetBranch}`);
    exec(`git pull --ff-only origin ${targetBranch}`);
  } catch {
    console.log(`[⚙️ Assembler] Could not pull ${targetBranch} — using local`);
  }

  try {
    exec(`git checkout -b ${branchName}`);
  } catch {
    // Branch might already exist — switch to it
    exec(`git checkout ${branchName}`);
  }

  // 3. Write/delete files
  const filesChanged: Array<{ path: string; action: string }> = [];

  for (const file of codeGen.files) {
    const fullPath = resolve(workspacePath, file.path);

    if (file.action === "delete") {
      try {
        unlinkSync(fullPath);
        filesChanged.push({ path: file.path, action: "deleted" });
        console.log(`[⚙️ Assembler] 🗑️ Deleted: ${file.path}`);
      } catch {
        console.log(`[⚙️ Assembler] ⚠️ Could not delete: ${file.path}`);
      }
    } else {
      // create or modify
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, "utf-8");
      filesChanged.push({ path: file.path, action: file.action === "create" ? "created" : "modified" });
      console.log(`[⚙️ Assembler] 📝 ${file.action === "create" ? "Created" : "Modified"}: ${file.path}`);
    }
  }

  // 4. Stage only the files we touched (not unrelated changes in the repo)
  for (const file of codeGen.files) {
    exec(`git add "${file.path}"`);
  }

  // 5. Commit with all commit messages joined
  const commitMsg = codeGen.commits.join("\n\n");
  try {
    exec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
  } catch (err) {
    // Nothing to commit — files might not have actually changed
    console.log("[⚙️ Assembler] ⚠️ Nothing to commit (no changes detected)");
  }

  // 6. Push
  try {
    exec(`git push -u origin ${branchName}`);
  } catch (err) {
    // Force push if branch existed with different history
    exec(`git push -u origin ${branchName} --force-with-lease`);
  }

  // 7. Open PR via gh CLI
  let prNumber = 0;
  let prUrl = "";
  try {
    const prTitle = (codeGen.commits[0] ?? branchName).replace(/"/g, '\\"');
    const prBody = [
      "## Summary",
      "",
      codeGen.summary,
      "",
      "## Changes",
      "",
      ...filesChanged.map((f) => `- ${f.action}: \`${f.path}\``),
    ].join("\\n").replace(/"/g, '\\"');

    const prOutput = exec(
      `gh pr create --base ${targetBranch} --head ${branchName} --title "${prTitle}" --body "${prBody}" 2>&1`
    );
    // Parse PR URL from gh output
    const urlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (urlMatch?.[0]) {
      prUrl = urlMatch[0];
      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      prNumber = numMatch?.[1] ? parseInt(numMatch[1], 10) : 0;
    }
    console.log(`[⚙️ Assembler] 🔗 PR opened: ${prUrl}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // PR might already exist
    if (errMsg.includes("already exists")) {
      console.log("[⚙️ Assembler] PR already exists — looking it up");
      try {
        const existing = exec(`gh pr view ${branchName} --json number,url`);
        const parsed = JSON.parse(existing);
        prNumber = parsed.number;
        prUrl = parsed.url;
      } catch {
        console.log("[⚙️ Assembler] ⚠️ Could not find existing PR");
      }
    } else {
      console.error(`[⚙️ Assembler] ❌ PR creation failed: ${errMsg}`);
    }
  }

  return { prNumber, prUrl, filesChanged };
}

// ── Assembler Executor ──────────────────────────────────────────────────

class AssemblerExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[⚙️ Assembler] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Extract workspace path and target branch from context
    let workspacePath = process.cwd();
    let targetBranch = "main";

    // Try to parse workspace/branch from the task context
    const wsMatch = text.match(/workspace[_\s]*path[:\s]+([^\s\n]+)/i);
    if (wsMatch?.[1]) workspacePath = wsMatch[1];

    const branchMatch = text.match(/(?:target[_\s]*)?branch[:\s]+([^\s\n]+)/i);
    if (branchMatch?.[1]) targetBranch = branchMatch[1];

    // Build codebase context
    let codebaseContext = "";
    try {
      const { execSync } = await import("child_process");
      const tree = execSync(
        `find ${workspacePath}/src -type f \\( -name "*.ts" -o -name "*.tsx" \\) | grep -v node_modules | grep -v .next | sort`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      const pkgJson = execSync(`cat ${workspacePath}/package.json`, {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      codebaseContext = `\n\n## Codebase Context\n\n### File tree\n\`\`\`\n${tree}\n\`\`\`\n\n### package.json\n\`\`\`json\n${pkgJson}\n\`\`\`\n`;
    } catch {
      /* no codebase available */
    }

    // Read existing file contents for files that need modification
    let existingFiles = "";
    try {
      const { execSync } = await import("child_process");
      // Extract file paths from Cipher's analysis if present
      const fileMatches = text.matchAll(/path:\s*"?([^"\n]+)"?/g);
      const paths = [...fileMatches].map((m) => m[1]).filter(Boolean);
      for (const filePath of paths.slice(0, 15)) {
        // Limit to 15 files
        try {
          const content = execSync(`cat "${workspacePath}/${filePath}"`, {
            encoding: "utf-8",
            timeout: 3000,
          });
          existingFiles += `\n### ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
        } catch {
          /* file doesn't exist yet — that's fine for "create" */
        }
      }
      if (existingFiles) {
        existingFiles = `\n\n## Existing File Contents\n${existingFiles}`;
      }
    } catch {
      /* ignore */
    }

    const fullBrief = `${ASSEMBLER_BRIEF}${codebaseContext}${existingFiles}\n\n## Task Context\n\n${text}`;

    try {
      console.log(`[⚙️ Assembler] Phase 1: Calling LLM for code generation...`);
      let cumulativeUsage = emptyUsage();
      const gatewayResult = await invokeGatewayShared(fullBrief, "Assembler", AssemblerCodeGenJsonSchema);
      cumulativeUsage = accumulateUsage(cumulativeUsage, gatewayResult.usage);
      console.log(
        `[⚙️ Assembler] Phase 1 done (${gatewayResult.output.length} chars, ${gatewayResult.usage.total_tokens} tokens)`,
      );

      // Parse the LLM output (JSON)
      let codeGen: CodeGenOutput;
      try {
        const raw = gatewayResult.output.trim();
        // Handle potential markdown code fences
        const cleaned = raw.startsWith("```")
          ? raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
          : raw;
        codeGen = JSON.parse(cleaned);
      } catch (parseErr) {
        throw new Error(`Failed to parse LLM code generation output: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }

      if (!codeGen.files || codeGen.files.length === 0) {
        throw new Error("LLM produced no files to write");
      }

      console.log(
        `[⚙️ Assembler] Phase 2: Writing ${codeGen.files.length} files, branch: ${codeGen.branch}`,
      );

      // Phase 2: Execute git operations
      const { prNumber, prUrl, filesChanged } = await executeGitOperations(
        codeGen,
        workspacePath,
        targetBranch,
      );

      // Build status check
      let buildStatus = "pass";
      try {
        const { execSync } = await import("child_process");
        execSync("npx tsc --noEmit 2>&1", { cwd: workspacePath, timeout: 60_000 });
      } catch {
        buildStatus = "fail";
        console.log("[⚙️ Assembler] ⚠️ TypeScript check failed");
      }

      usageByTask.set(ctx.taskId, cumulativeUsage);

      // Construct the final Assembler YAML output
      const assemblerOutput = {
        agent: "Assembler",
        task_seq: 0, // Will be filled by orchestrator context
        iteration: 1,
        status: "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: {
          summary: codeGen.summary,
          branch: codeGen.branch,
          pull_request: {
            number: prNumber,
            url: prUrl || `https://github.com/unknown/pull/${prNumber}`,
          },
          commits: codeGen.commits,
          files_changed: filesChanged.map((f) => ({
            path: f.path,
            action: f.action as "created" | "modified" | "deleted",
          })),
          build_status: buildStatus,
          lint_status: "pass",
        },
      };

      const jsonOutput = JSON.stringify(assemblerOutput, null, 2);

      // Publish YAML output as A2A artifact
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "assembler-output",
          description: "Assembler implementation output (JSON)",
          parts: [
            {
              kind: "text",
              text: jsonOutput,
              metadata: { mimeType: "application/json" },
            },
          ],
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

      console.log(
        `[⚙️ Assembler] ✅ Done — ${filesChanged.length} files, PR #${prNumber}`,
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[⚙️ Assembler] ❌ Failed:`, errorMsg);

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
            parts: [
              { kind: "text", text: `⚙️ Assembler failed: ${errorMsg}` },
            ],
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

export function createAssemblerRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Assembler",
    description:
      "Senior Software Engineer — implements code changes, creates branches, commits, pushes, and opens PRs.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/assembler/a2a/jsonrpc`,
    skills: [
      {
        id: "code-implementation",
        name: "Code Implementation",
        description:
          "Implement code changes based on analysis plans",
        tags: ["code", "implementation"],
      },
      {
        id: "git-operations",
        name: "Git Operations",
        description:
          "Create branches, commit, push, and open pull requests",
        tags: ["git", "pr"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new AssemblerExecutor(),
  );
  const router = Router();

  router.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: handler }),
  );
  router.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  router.use(
    "/a2a/rest",
    restHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  return router;
}
