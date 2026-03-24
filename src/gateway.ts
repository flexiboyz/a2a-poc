/**
 * Multi-model gateway via OpenRouter SDK.
 *
 * Each agent can use a different model. Config via AGENT_MODELS map.
 * Uses @openrouter/sdk for proper streaming + token tracking.
 */

import { OpenRouter } from "@openrouter/sdk";

// ── Config ──────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";

// Fallback to OpenClaw Gateway
const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ── Per-agent model config ──────────────────────────────────────────────────

const AGENT_MODELS: Record<string, string> = {
  WorkflowMaster: process.env["MODEL_WORKFLOWMASTER"] ?? "google/gemini-2.5-flash",
  Cipher:         process.env["MODEL_CIPHER"] ?? "google/gemini-2.5-flash",
  Assembler:      process.env["MODEL_ASSEMBLER"] ?? "anthropic/claude-sonnet-4-20250514",
  Sentinel:       process.env["MODEL_SENTINEL"] ?? "anthropic/claude-sonnet-4-20250514",
  Hammer:         process.env["MODEL_HAMMER"] ?? "google/gemini-2.5-flash",
  Prism:          process.env["MODEL_PRISM"] ?? "google/gemini-2.5-flash",
  Bastion:        process.env["MODEL_BASTION"] ?? "google/gemini-2.5-flash",
  default:        process.env["MODEL_DEFAULT"] ?? "google/gemini-2.5-flash",
};

// ── Model pricing (per 1M tokens) ────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "anthropic/claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "anthropic/claude-haiku-3-5-20241022": { input: 1.0, output: 5.0 },
  "google/gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10.0 },
  default: { input: 3.0, output: 15.0 },
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  is_estimated: boolean;
  retry_token_overhead: number;
  model?: string;
}

export interface GatewayResult {
  output: string;
  usage: TokenUsage;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

function calculateCost(inputTokens: number, outputTokens: number, model?: string): number {
  const pricing = MODEL_PRICING[model ?? ""] ?? MODEL_PRICING["default"]!;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function getModelForAgent(agentName: string): string {
  return AGENT_MODELS[agentName] ?? AGENT_MODELS["default"] ?? "google/gemini-2.5-flash";
}

// ── OpenRouter SDK client (singleton) ───────────────────────────────────────

let _client: OpenRouter | null = null;
function getClient(): OpenRouter {
  if (!_client) {
    _client = new OpenRouter({ apiKey: OPENROUTER_API_KEY });
  }
  return _client;
}

// ── OpenRouter invocation via SDK ───────────────────────────────────────────

async function invokeOpenRouter(task: string, agentName: string): Promise<GatewayResult> {
  const model = getModelForAgent(agentName);
  const client = getClient();

  try {
    const result = client.callModel({
      model,
      input: [{ role: "user", content: task }],
    });

    // Get full response (includes usage)
    const response = await result.getResponse();
    const output = (response as any).output
      ?.filter((o: any) => o.type === "message")
      ?.flatMap((o: any) => o.content?.filter((c: any) => c.type === "output_text")?.map((c: any) => c.text) ?? [])
      ?.join("") ?? await result.getText();

    const rawUsage = (response as any).usage;
    let usage: TokenUsage;
    if (rawUsage) {
      const inputTokens = Number(rawUsage.input_tokens ?? rawUsage.prompt_tokens) || 0;
      const outputTokens = Number(rawUsage.output_tokens ?? rawUsage.completion_tokens) || 0;
      usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated_cost: calculateCost(inputTokens, outputTokens, model),
        is_estimated: false,
        retry_token_overhead: 0,
        model,
      };
    } else {
      const inputTokens = estimateTokens(task);
      const outputTokens = estimateTokens(output);
      usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated_cost: calculateCost(inputTokens, outputTokens, model),
        is_estimated: true,
        retry_token_overhead: 0,
        model,
      };
    }

    console.log(`[gateway] ${agentName} → ${model} (${usage.input_tokens}+${usage.output_tokens} tokens, $${usage.estimated_cost.toFixed(4)})`);
    return { output, usage };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenRouter error for ${agentName} (${model}): ${msg}`);
  }
}

// ── OpenClaw Gateway fallback ───────────────────────────────────────────────

async function invokeOpenClawGateway(task: string): Promise<GatewayResult> {
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
        args: { runtime: "acp", agentId: "claude", mode: "run", task, runTimeoutSeconds: 300 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as Record<string, any>;
    const result = data?.["result"]?.["details"] ?? data?.["result"] ?? data;
    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);

    const rawUsage = data?.["usage"] ?? data?.["result"]?.["usage"] ?? data?.["metadata"]?.["usage"];
    let usage: TokenUsage;

    if (rawUsage && typeof rawUsage === "object" && rawUsage.input_tokens != null) {
      const inputTokens = Number(rawUsage.input_tokens) || 0;
      const outputTokens = Number(rawUsage.output_tokens) || 0;
      const usedModel = data?.["model"] ?? data?.["result"]?.["model"];
      usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated_cost: calculateCost(inputTokens, outputTokens, usedModel),
        is_estimated: false,
        retry_token_overhead: 0,
        model: usedModel,
      };
    } else {
      const inputTokens = estimateTokens(task);
      const outputTokens = estimateTokens(output);
      usage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated_cost: calculateCost(inputTokens, outputTokens),
        is_estimated: true,
        retry_token_overhead: 0,
      };
    }

    return { output, usage };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Gateway invocation timed out (120s)");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Main export — routes to OpenRouter SDK or OpenClaw Gateway ──────────────

export async function invokeGateway(task: string, agentName?: string): Promise<GatewayResult> {
  if (OPENROUTER_API_KEY) {
    return invokeOpenRouter(task, agentName ?? "default");
  }
  return invokeOpenClawGateway(task);
}

export function accumulateUsage(base: TokenUsage, additional: TokenUsage): TokenUsage {
  return {
    input_tokens: base.input_tokens + additional.input_tokens,
    output_tokens: base.output_tokens + additional.output_tokens,
    total_tokens: base.total_tokens + additional.total_tokens,
    estimated_cost: base.estimated_cost + additional.estimated_cost,
    is_estimated: base.is_estimated || additional.is_estimated,
    retry_token_overhead: base.retry_token_overhead + additional.retry_token_overhead,
  };
}

export function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0, is_estimated: true, retry_token_overhead: 0 };
}
