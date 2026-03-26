/**
 * Canvas A2A Agent — Image generation from design descriptions
 *
 * Takes Prism's mockup descriptions (or Moodboard's design prompt)
 * and generates actual UI mockup images via Gemini 2.5 Flash Image.
 *
 * The generated images are returned as base64 data URLs in the output.
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

const IMAGE_MODEL = process.env["MODEL_CANVAS"] ?? "google/gemini-2.5-flash-image";

const CANVAS_SYSTEM_PROMPT = `You are a UI/UX mockup generator. Generate a high-fidelity UI mockup image based on the description provided.

RULES:
- Generate EXACTLY ONE image per request
- The image should be a realistic UI mockup, not a wireframe
- Follow the colors, typography, spacing, and layout described precisely
- Use dark theme (#0a0a0a background) unless specified otherwise
- Include realistic content (real text, not lorem ipsum)
- Make it look like a real app screenshot
- Include proper padding, margins, and visual hierarchy
- Use modern UI patterns (rounded corners, subtle shadows, clean typography)

Generate the image now.`;

// ── Token usage tracking ────────────────────────────────────────────────

const usageByTask = new Map<string, TokenUsage>();
export function getLastCanvasUsage(taskId?: string): TokenUsage | null {
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

// ── Image generation ────────────────────────────────────────────────────

interface GeneratedImage {
  name: string;
  dataUrl: string;
}

async function generateImage(
  prompt: string,
  name: string,
): Promise<{ image: GeneratedImage | null; usage: TokenUsage }> {
  const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://rockeros.rockerone.io",
      "X-Title": "A2A Canvas Agent",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [
        { role: "user", content: `${CANVAS_SYSTEM_PROMPT}\n\n## Mockup Description\n\n${prompt}` },
      ],
      max_tokens: 8192,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json() as any;
  const content = data?.choices?.[0]?.message?.content ?? "";
  const rawUsage = data?.usage;
  const inputTokens = Number(rawUsage?.prompt_tokens) || 0;
  const outputTokens = Number(rawUsage?.completion_tokens) || 0;

  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    estimated_cost: 0,
    is_estimated: !rawUsage,
    retry_token_overhead: 0,
    model: IMAGE_MODEL,
  };

  // Extract base64 image from content
  // Gemini returns images as inline base64 in the content
  const base64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
  if (base64Match) {
    return {
      image: { name, dataUrl: base64Match[0] },
      usage,
    };
  }

  // Sometimes the image is just raw base64 without the data URL prefix
  // Check if content contains a large base64 block
  const rawBase64 = content.match(/[A-Za-z0-9+/=]{1000,}/);
  if (rawBase64) {
    // Assume PNG
    return {
      image: { name, dataUrl: `data:image/png;base64,${rawBase64[0]}` },
      usage,
    };
  }

  console.log(`[🖼️ Canvas] No image found in response for "${name}" (content length: ${content.length})`);
  return { image: null, usage };
}

// ── Canvas Executor ─────────────────────────────────────────────────────

class CanvasExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = ctx.userMessage?.parts
      ?.map((p: any) => ("text" in p ? p.text : ""))
      .join(" ")
      .trim() ?? "";

    console.log(`[🖼️ Canvas] Received: "${text.slice(0, 120)}${text.length > 120 ? "..." : ""}"`);

    try {
      // Extract mockup descriptions from Prism output or direct prompts
      const mockupPrompts: Array<{ name: string; prompt: string }> = [];

      // Try to find Prism's mockup_descriptions in the context
      const mockupMatches = text.matchAll(/"name"\s*:\s*"([^"]+)"[^}]*"prompt"\s*:\s*"([^"]+)"/g);
      for (const match of mockupMatches) {
        if (match[1] && match[2]) {
          mockupPrompts.push({ name: match[1], prompt: match[2] });
        }
      }

      // If no structured mockups found, try to find design_prompt from Moodboard
      if (mockupPrompts.length === 0) {
        const designPromptMatch = text.match(/"design_prompt"\s*:\s*"([^"]+)"/);
        if (designPromptMatch?.[1]) {
          mockupPrompts.push({ name: "moodboard-design", prompt: designPromptMatch[1] });
        }
      }

      // Fallback: use the entire context as a single prompt
      if (mockupPrompts.length === 0) {
        mockupPrompts.push({ name: "mockup", prompt: text.slice(0, 4000) });
      }

      // Limit to 4 images max
      const prompts = mockupPrompts.slice(0, 4);
      console.log(`[🖼️ Canvas] Generating ${prompts.length} image(s)...`);

      let cumulativeUsage = emptyUsage();
      const images: GeneratedImage[] = [];

      for (const { name, prompt } of prompts) {
        console.log(`[🖼️ Canvas] Generating: ${name}...`);
        try {
          const { image, usage } = await generateImage(prompt, name);
          cumulativeUsage = accumulateUsage(cumulativeUsage, usage);
          if (image) {
            images.push(image);
            console.log(`[🖼️ Canvas] ✅ Generated: ${name} (${Math.round(image.dataUrl.length / 1024)}kb)`);
          } else {
            console.log(`[🖼️ Canvas] ⚠️ No image returned for: ${name}`);
          }
        } catch (err) {
          console.error(`[🖼️ Canvas] ❌ Failed to generate ${name}:`, err instanceof Error ? err.message : err);
        }
      }

      usageByTask.set(ctx.taskId, cumulativeUsage);

      if (images.length === 0) {
        throw new Error("No images were generated — the model may not support image generation or the prompts were rejected");
      }

      const canvasOutput = {
        agent: "Canvas",
        task_seq: 0,
        iteration: 1,
        status: "done",
        waiting_reason: null,
        out_of_scope: [],
        pipeline_suggestion: null,
        output: {
          summary: `Generated ${images.length} mockup image(s)`,
          images: images.map((img) => ({
            name: img.name,
            data_url: img.dataUrl,
          })),
          prompts_used: prompts.map((p) => p.name),
        },
      };

      // For the artifact, include a lighter version (just metadata, not full base64)
      const artifactOutput = {
        ...canvasOutput,
        output: {
          ...canvasOutput.output,
          images: images.map((img) => ({
            name: img.name,
            size_kb: Math.round(img.dataUrl.length / 1024),
            has_image: true,
          })),
        },
      };

      const jsonOutput = JSON.stringify(canvasOutput, null, 2);
      const artifactJson = JSON.stringify(artifactOutput, null, 2);

      // Publish artifact (metadata only — images are in the message)
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "canvas-output",
          description: `Canvas generated ${images.length} mockup image(s)`,
          parts: [{ kind: "text", text: artifactJson, metadata: { mimeType: "application/json" } }],
        },
      };
      bus.publish(artifactEvent);

      // Message includes full base64 images
      const response: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: jsonOutput }],
        contextId: ctx.contextId,
      };
      bus.publish(response);
      bus.finished();

      console.log(`[🖼️ Canvas] ✅ Done — ${images.length} image(s) generated`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[🖼️ Canvas] ❌ Failed:`, errorMsg);

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
            parts: [{ kind: "text", text: `🖼️ Canvas failed: ${errorMsg}` }],
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

export function createCanvasRouter(baseUrl: string): Router {
  const card: AgentCard = {
    name: "Canvas",
    description: "Image Generator — creates UI mockup images from design descriptions using AI image generation.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/canvas/a2a/jsonrpc`,
    skills: [
      {
        id: "mockup-generation",
        name: "Mockup Generation",
        description: "Generate UI mockup images from detailed design descriptions",
        tags: ["image", "mockup", "design", "generation"],
      },
    ],
    capabilities: { pushNotifications: false, streaming: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new CanvasExecutor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
