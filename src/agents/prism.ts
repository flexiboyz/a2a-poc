/**
 * Prism A2A Agent — UX Designer & Mockup Architect
 *
 * Produces detailed UI/UX specifications, component breakdowns,
 * user flows, and highly detailed mockup descriptions that can
 * feed into an image generation agent.
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
import { PrismDesignJsonSchema } from "../schemas/json-schemas.js";

// ── Config ────────────────────────────────────────────────────────────────

const PRISM_BRIEF = `# You are Prism 🌈

## Role
UX Designer & Mockup Architect — you design user interfaces and produce detailed specifications
that developers can implement and that image generation models can visualize.

## What To Do

1. Read the task context and any previous agent outputs (especially Cipher's analysis)
2. Design the UI/UX solution:
   - Component hierarchy and structure
   - Layout specifications (spacing, alignment, responsive behavior)
   - Color palette and typography choices
   - Interactive states (hover, active, disabled, loading, error, empty)
   - Animations and transitions
3. Define user flows (step-by-step interactions)
4. Write DETAILED mockup descriptions — treat these as prompts for an image generation model:
   - Describe EXACTLY what the screen looks like
   - Include colors (hex), sizes (px/rem), spacing, typography
   - Describe the visual hierarchy
   - Include real example content (not "Lorem ipsum")
   - Specify dark mode vs light mode

## Mockup Description Format

Each mockup description should be a standalone prompt that could generate a UI mockup image.
Be extremely specific:
- "A dark-themed (#0a0a0a background) music streaming app showing an artist profile page.
  Header: 80px tall, artist avatar (64px circle) on the left, artist name 'DJ Shadow' in 
  white 24px Inter Bold, a white outline 'Tip' button with heart icon aligned far right.
  Below: two sections — 'Albums (3)' with horizontal scroll cards (180x200px, rounded-lg,
  cover art with title overlay), then 'Tracks (12)' as a vertical list..."

## CRITICAL RULES

1. Be SPECIFIC — vague descriptions produce vague mockups
2. Use real content examples, not placeholders
3. Every component must have: visual description, interactive states, responsive behavior
4. Mockup descriptions must include exact colors, sizes, spacing
5. Consider accessibility: contrast ratios, touch targets (min 44px), screen reader labels
6. Design for the existing codebase style (if provided in context)
7. Include both mobile and desktop layouts when relevant
`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastPrismUsage(taskId?: string): TokenUsage | null {
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

// ── Prism Executor ──────────────────────────────────────────────────────

class PrismExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🌈 Prism] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Try to gather existing UI context from workspace
    let uiContext = "";
    let workspacePath = process.cwd();
    const wsMatch = text.match(/workspace[_\s]*path[:\s]+([^\s\n]+)/i);
    if (wsMatch?.[1]) workspacePath = wsMatch[1];

    try {
      const { execSync } = await import("child_process");

      // Get existing component names
      const components = execSync(
        `find ${workspacePath}/components ${workspacePath}/app 2>/dev/null -type f -name "*.tsx" | grep -v node_modules | grep -v .next | sort | head -30`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      if (components) {
        uiContext += `\n\n## Existing UI Components\n\`\`\`\n${components}\n\`\`\`\n`;
      }

      // Check for Tailwind config or global styles
      try {
        const tailwind = execSync(`cat ${workspacePath}/tailwind.config.ts 2>/dev/null || cat ${workspacePath}/tailwind.config.js 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 2000,
        });
        uiContext += `\n### Tailwind Config\n\`\`\`\n${tailwind.slice(0, 3000)}\n\`\`\`\n`;
      } catch { /* no tailwind */ }

      // Check for global CSS
      try {
        const globalCss = execSync(`cat ${workspacePath}/app/globals.css 2>/dev/null || cat ${workspacePath}/styles/globals.css 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 2000,
        });
        uiContext += `\n### Global Styles\n\`\`\`css\n${globalCss.slice(0, 3000)}\n\`\`\`\n`;
      } catch { /* no global css */ }
    } catch { /* no workspace */ }

    const fullBrief = `${PRISM_BRIEF}${uiContext}\n\n## Task Context\n\n${text}`;

    try {
      console.log(`[🌈 Prism] Calling LLM for design...`);
      let cumulativeUsage = emptyUsage();
      const gatewayResult = await invokeGatewayShared(fullBrief, "Prism", PrismDesignJsonSchema);
      cumulativeUsage = accumulateUsage(cumulativeUsage, gatewayResult.usage);
      console.log(`[🌈 Prism] Done (${gatewayResult.output.length} chars, ${gatewayResult.usage.total_tokens} tokens)`);

      let design: any;
      try {
        const raw = gatewayResult.output.trim();
        const cleaned = raw.startsWith("```")
          ? raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
          : raw;
        design = JSON.parse(cleaned);
      } catch (parseErr) {
        throw new Error(`Failed to parse design output: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }

      usageByTask.set(ctx.taskId, cumulativeUsage);

      const prismOutput = {
        agent: "Prism",
        task_seq: 0,
        iteration: 1,
        status: "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: design,
      };

      const jsonOutput = JSON.stringify(prismOutput, null, 2);

      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "prism-output",
          description: "Prism UX design output (JSON)",
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

      console.log(`[🌈 Prism] ✅ Done — ${design.components?.length ?? 0} components, ${design.mockup_descriptions?.length ?? 0} mockups`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🌈 Prism] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🌈 Prism failed: ${errorMsg}` }],
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

export function createPrismRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Prism",
    description: "UX Designer & Mockup Architect — produces detailed UI specs, component breakdowns, user flows, and image-gen-ready mockup descriptions.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/prism/a2a/jsonrpc`,
    skills: [
      {
        id: "ui-design",
        name: "UI/UX Design",
        description: "Design components, layouts, and user flows with accessibility in mind",
        tags: ["design", "ux", "ui"],
      },
      {
        id: "mockup-descriptions",
        name: "Mockup Descriptions",
        description: "Generate detailed visual descriptions for image generation models",
        tags: ["mockup", "visual", "image-gen"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new PrismExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
