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
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────

const IMAGE_MODEL = process.env["MODEL_CANVAS"] ?? "google/gemini-2.5-flash-image";

const CANVAS_SYSTEM_PROMPT = `You are a UI/UX mockup generator. Generate a high-fidelity UI mockup image.

CRITICAL: Follow the description EXACTLY. Do not invent your own design. The description below specifies:
- The exact type of application/page to show
- Color palette and theme
- Typography and layout
- Specific UI elements and components

RULES:
- Generate EXACTLY ONE image
- It must be a realistic UI mockup screenshot, not a wireframe or illustration
- Follow ALL colors, fonts, spacing, and layout from the description — do NOT substitute with generic designs
- Include realistic content text (not lorem ipsum)
- Make it look like an actual app screenshot
- The mockup must match the described application type (music app, dashboard, landing page, etc.)

IMPORTANT: Read the description carefully. If it says "audio streaming platform", show a music/audio app. If it says "dark warm palette", use those exact colors. Do NOT default to generic e-commerce or unrelated UIs.`;

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
        { role: "user", content: `${CANVAS_SYSTEM_PROMPT}\n\n## Mockup Description\n\nGenerate a UI SCREENSHOT mockup of a web/mobile application with the following design:\n\n${prompt}\n\nREMINDER: This must be a UI APPLICATION mockup (buttons, navigation, content sections, cards, etc.), NOT a poster, fashion item, or physical product.` },
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
  const images = data?.choices?.[0]?.message?.images ?? [];
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

  // OpenRouter returns images in .message.images[].image_url.url as data URLs
  if (images.length > 0) {
    const imageUrl = images[0]?.image_url?.url;
    if (imageUrl) {
      return { image: { name, dataUrl: imageUrl }, usage };
    }
  }

  // Fallback: check content for inline base64
  const base64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
  if (base64Match) {
    return { image: { name, dataUrl: base64Match[0] }, usage };
  }

  console.log(`[🖼️ Canvas] No image found in response for "${name}" (content: ${content.length} chars, images array: ${images.length})`);
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
      // Extract mockup descriptions from previous agent outputs in the pipeline context
      const mockupPrompts: Array<{ name: string; prompt: string }> = [];

      // Strategy 1: Find ALL JSON objects in the text and try to parse them
      // The pipeline context may contain multiple agent outputs as JSON strings
      const jsonCandidates: string[] = [];
      let braceDepth = 0;
      let jsonStart = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") {
          if (braceDepth === 0) jsonStart = i;
          braceDepth++;
        } else if (text[i] === "}") {
          braceDepth--;
          if (braceDepth === 0 && jsonStart !== -1) {
            const candidate = text.slice(jsonStart, i + 1);
            if (candidate.length > 100) jsonCandidates.push(candidate);
            jsonStart = -1;
          }
        }
      }

      // Separate Prism and Moodboard prompts — Prism takes priority
      const prismPrompts: Array<{ name: string; prompt: string }> = [];
      const moodboardPrompts: Array<{ name: string; prompt: string }> = [];

      for (const candidate of jsonCandidates) {
        try {
          const parsed = JSON.parse(candidate);
          // Extract from Prism output (PRIORITY)
          if (parsed?.output?.mockup_descriptions) {
            for (const mockup of parsed.output.mockup_descriptions) {
              if (mockup.prompt) {
                prismPrompts.push({ name: mockup.name ?? "mockup", prompt: mockup.prompt });
              }
            }
          }
          // Extract from Moodboard output (fallback)
          if (parsed?.output?.synthesized_moodboard?.design_prompt) {
            moodboardPrompts.push({
              name: "moodboard-design",
              prompt: parsed.output.synthesized_moodboard.design_prompt,
            });
          }
        } catch { /* not valid JSON */ }
      }

      // Prism prompts first, then Moodboard
      mockupPrompts.push(...prismPrompts, ...moodboardPrompts);

      // Strategy 2: Regex for prompt fields (handles YAML-wrapped or escaped JSON)
      if (mockupPrompts.length === 0) {
        // Match "prompt": "..." with content longer than 30 chars
        const promptMatches = text.matchAll(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        for (const m of promptMatches) {
          if (m[1] && m[1].length > 30) {
            mockupPrompts.push({ name: "extracted-prompt", prompt: m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n") });
          }
        }
      }

      // Strategy 3: Look for design_prompt 
      if (mockupPrompts.length === 0) {
        const designMatch = text.match(/design_prompt[:\s]*["']?((?:[^"'\n]){30,})["']?/);
        if (designMatch?.[1]) {
          mockupPrompts.push({ name: "design", prompt: designMatch[1] });
        }
      }

      // Strategy 4: Extract Prism summary
      if (mockupPrompts.length === 0) {
        const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (summaryMatch?.[1] && summaryMatch[1].length > 40) {
          mockupPrompts.push({ name: "from-summary", prompt: summaryMatch[1] });
        }
      }

      // Fallback: use the task topic only
      if (mockupPrompts.length === 0) {
        const topicMatch = text.match(/## (?:Topic|Task)\s*\n([\s\S]*?)(?=\n##|$)/);
        const prompt = topicMatch?.[1]?.trim() ?? text.slice(0, 2000);
        mockupPrompts.push({ name: "fallback", prompt });
      }

      console.log(`[🖼️ Canvas] Extracted ${mockupPrompts.length} prompt(s): ${mockupPrompts.map(p => `${p.name} (${p.prompt.length} chars)`).join(", ")}`);

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

      // Save images to disk and create URLs
      const savedImages: Array<{ name: string; url: string; size_kb: number }> = [];
      const generatedDir = resolve(__dirname, "../../public/generated");

      for (const img of images) {
        const filename = `${Date.now()}-${img.name.replace(/[^a-z0-9-]/gi, "_")}.png`;
        const filepath = resolve(generatedDir, filename);
        
        // Extract base64 data and write to file
        const base64Data = img.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        writeFileSync(filepath, Buffer.from(base64Data, "base64"));
        
        savedImages.push({
          name: img.name,
          url: `/generated/${filename}`,
          size_kb: Math.round(base64Data.length * 3 / 4 / 1024),
        });
        console.log(`[🖼️ Canvas] 💾 Saved: ${filename} (${savedImages[savedImages.length - 1]!.size_kb}kb)`);
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
          images: savedImages,
          prompts_used: prompts.map((p) => p.name),
        },
      };

      const jsonOutput = JSON.stringify(canvasOutput, null, 2);

      // Publish artifact
      const artifactEvent: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        lastChunk: true,
        artifact: {
          artifactId: uuidv4(),
          name: "canvas-output",
          description: `Canvas generated ${images.length} mockup image(s)`,
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
