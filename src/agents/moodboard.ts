/**
 * Moodboard A2A Agent — Visual inspiration analyzer
 *
 * Flow:
 *   1. Receives task context
 *   2. Pauses with input-required — asks user to upload 1-4 inspiration images
 *   3. User uploads images (base64 data URLs in reply)
 *   4. Sends images to vision model (Gemini Flash) for analysis
 *   5. Produces structured moodboard: palette, typography, textures, mood, design prompt
 *   6. Output feeds into Prism for detailed UI design
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

import { emptyUsage, accumulateUsage, type TokenUsage } from "../gateway.js";

// ── Config ────────────────────────────────────────────────────────────────

const VISION_MODEL = process.env["MODEL_MOODBOARD"] ?? "google/gemini-2.5-flash";

const MOODBOARD_ANALYSIS_PROMPT = `You are a design analyst. Analyze these inspiration images and produce a structured moodboard.

For each image, identify:
- Dominant colors (hex codes)
- Typography style (serif, sans-serif, monospace, display)
- Mood/atmosphere (dark, light, warm, cold, minimal, maximal, playful, serious)
- Layout patterns (grid, freeform, centered, asymmetric)
- Textures and materials (glass, metal, paper, fabric, gradient, flat)
- Notable UI patterns (cards, lists, floating elements, overlays)

Then synthesize a unified moodboard from ALL images:

Output as JSON:
{
  "images_analysis": [
    {
      "image_index": 1,
      "dominant_colors": ["#hex1", "#hex2", "#hex3"],
      "typography": "description",
      "mood": "description",
      "layout": "description",
      "textures": "description",
      "notable_patterns": ["pattern1", "pattern2"]
    }
  ],
  "synthesized_moodboard": {
    "color_palette": {
      "primary": "#hex",
      "secondary": "#hex",
      "accent": "#hex",
      "background": "#hex",
      "surface": "#hex",
      "text": "#hex",
      "muted": "#hex"
    },
    "typography": {
      "headings": "font suggestion + weight",
      "body": "font suggestion + weight",
      "code": "font suggestion"
    },
    "mood": "overall mood description",
    "design_principles": ["principle1", "principle2", "principle3"],
    "layout_approach": "description of layout strategy",
    "textures_and_effects": ["effect1", "effect2"],
    "design_prompt": "A comprehensive prompt that captures the entire moodboard aesthetic, suitable for passing to a UI design agent. Be very specific about colors, spacing, typography, and visual hierarchy."
  }
}`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastMoodboardUsage(taskId?: string): TokenUsage | null {
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

// ── Vision API call ─────────────────────────────────────────────────────

async function analyzeImagesWithVision(
  imageDataUrls: string[],
  taskContext: string,
): Promise<{ output: string; usage: TokenUsage }> {
  const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";

  // Build multimodal content array
  const content: any[] = [
    { type: "text", text: `${MOODBOARD_ANALYSIS_PROMPT}\n\n## Task Context\n${taskContext}` },
  ];

  for (let i = 0; i < imageDataUrls.length; i++) {
    const dataUrl = imageDataUrls[i]!;
    if (dataUrl.startsWith("data:image/")) {
      content.push({
        type: "image_url",
        image_url: { url: dataUrl },
      });
    }
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://rockeros.rockerone.io",
      "X-Title": "A2A Moodboard Agent",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 4096,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vision API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const output = data?.choices?.[0]?.message?.content ?? "";
  const rawUsage = data?.usage;
  const inputTokens = Number(rawUsage?.prompt_tokens) || 0;
  const outputTokens = Number(rawUsage?.completion_tokens) || 0;

  return {
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      estimated_cost: 0, // Flash is cheap
      is_estimated: !rawUsage,
      retry_token_overhead: 0,
      model: VISION_MODEL,
    },
  };
}

// ── Moodboard Executor ──────────────────────────────────────────────────

class MoodboardExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🎨 Moodboard] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    // Check if this is a resumed execution (user replied with images)
    const isResume = ctx.task && ctx.task.status?.state === "input-required";

    if (!isResume) {
      // First execution — ask for images
      console.log(`[🎨 Moodboard] → requesting inspiration images (input-required)`);

      const task: Task = {
        kind: "task",
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: "input-required",
          message: {
            kind: "message",
            messageId: uuidv4(),
            role: "agent",
            parts: [{
              kind: "text",
              text: `🎨 **Moodboard** needs your inspiration!\n\nUpload **1 to 4 images** that capture the visual direction you want.\nThese can be: screenshots of apps you like, color palettes, textures, UI elements, or anything that inspires the design.\n\nI'll analyze them and produce a structured moodboard for the design agent.`,
            }],
            contextId: ctx.contextId,
          },
          timestamp: new Date().toISOString(),
        },
        history: [],
      };

      bus.publish(task);
      bus.finished();
      return;
    }

    // Resumed — user has replied (possibly with images)
    console.log(`[🎨 Moodboard] Resuming with user input`);

    // Extract base64 image data URLs from the reply
    const imageDataUrls: string[] = [];
    const parts = ctx.userMessage?.parts ?? [];
    for (const part of parts) {
      if ("text" in part) {
        const partText = (part as any).text ?? "";
        // Extract data URLs from text
        const dataUrlMatches = partText.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g);
        if (dataUrlMatches) {
          imageDataUrls.push(...dataUrlMatches);
        }
        // Also check if the reply itself contains image markers
        if (partText.startsWith("data:image/")) {
          imageDataUrls.push(partText);
        }
      }
      // Handle file/image parts if A2A SDK supports them
      if ("data" in part && (part as any).mimeType?.startsWith("image/")) {
        imageDataUrls.push(`data:${(part as any).mimeType};base64,${(part as any).data}`);
      }
    }

    if (imageDataUrls.length === 0) {
      // No images found — check if user just typed "go" or similar
      const replyText = parts.map((p: any) => ("text" in p ? p.text : "")).join("").trim().toLowerCase();
      if (replyText === "go" || replyText === "let's go" || replyText === "skip") {
        // Continue without images — produce a generic moodboard from task context
        console.log(`[🎨 Moodboard] No images provided, producing context-based moodboard`);
      } else {
        // Send error — no images detected
        const response: Message = {
          kind: "message",
          messageId: uuidv4(),
          role: "agent",
          parts: [{
            kind: "text",
            text: JSON.stringify({
              agent: "Moodboard",
              task_seq: 0,
              iteration: 1,
              status: "fail",
              output: { error: "No images detected in your reply. Please upload 1-4 images." },
            }, null, 2),
          }],
          contextId: ctx.contextId,
        };
        bus.publish(response);
        bus.finished();
        return;
      }
    }

    try {
      let cumulativeUsage = emptyUsage();
      let moodboard: any;

      if (imageDataUrls.length > 0) {
        console.log(`[🎨 Moodboard] Analyzing ${imageDataUrls.length} image(s) with ${VISION_MODEL}...`);
        const result = await analyzeImagesWithVision(imageDataUrls, text);
        cumulativeUsage = accumulateUsage(cumulativeUsage, result.usage);

        try {
          const cleaned = result.output.trim().startsWith("```")
            ? result.output.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
            : result.output;
          moodboard = JSON.parse(cleaned);
        } catch {
          moodboard = { raw_analysis: result.output, error: "Could not parse structured output" };
        }

        console.log(`[🎨 Moodboard] Vision analysis done (${result.usage.total_tokens} tokens)`);
      } else {
        moodboard = {
          images_analysis: [],
          synthesized_moodboard: {
            color_palette: { primary: "#ffffff", secondary: "#000000", accent: "#3b82f6", background: "#0a0a0a", surface: "#111111", text: "#e0e0e0", muted: "#888888" },
            typography: { headings: "Inter Bold", body: "Inter Regular", code: "JetBrains Mono" },
            mood: "Modern dark minimal — derived from task context only (no images provided)",
            design_principles: ["Minimalism", "High contrast", "Clear hierarchy"],
            layout_approach: "Content-first with generous whitespace",
            textures_and_effects: ["Subtle borders", "Soft shadows"],
            design_prompt: "A modern dark-themed interface with clean typography and minimal decoration.",
          },
        };
      }

      usageByTask.set(ctx.taskId, cumulativeUsage);

      const moodboardOutput = {
        agent: "Moodboard",
        task_seq: 0,
        iteration: 1,
        status: "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: moodboard,
      };

      const jsonOutput = JSON.stringify(moodboardOutput, null, 2);

      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "moodboard-output",
          description: "Moodboard visual analysis (JSON)",
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

      console.log(`[🎨 Moodboard] ✅ Done — ${imageDataUrls.length} images analyzed`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🎨 Moodboard] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🎨 Moodboard failed: ${errorMsg}` }],
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

export function createMoodboardRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Moodboard",
    description: "Visual inspiration analyzer — pauses for image uploads, analyzes with vision AI, produces structured moodboard for design agents.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/moodboard/a2a/jsonrpc`,
    skills: [
      {
        id: "visual-analysis",
        name: "Visual Analysis",
        description: "Analyze inspiration images to extract colors, typography, mood, and patterns",
        tags: ["vision", "design", "analysis"],
      },
      {
        id: "moodboard-generation",
        name: "Moodboard Generation",
        description: "Synthesize a unified moodboard from multiple inspiration images",
        tags: ["moodboard", "design", "creative"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new MoodboardExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
