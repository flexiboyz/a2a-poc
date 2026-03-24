/**
 * Multi-model gateway via OpenRouter API.
 *
 * Each agent can use a different model. Config via AGENT_MODELS map.
 * Falls back to OpenClaw Gateway if OPENROUTER_API_KEY is not set.
 */

// ── Config ──────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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

// ── OpenRouter invocation ───────────────────────────────────────────────────

async function invokeOpenRouter(task: string, agentName: string): Promise<GatewayResult> {
  const model = getModelForAgent(agentName);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://rockeros.rockerone.io",
        "X-Title": "A2A Pipeline POC",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: task },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json() as any;
    const output = data?.choices?.[0]?.message?.content ?? "";
    const rawUsage = data?.usage;
    const usedModel = data?.model ?? model;

    let usage: TokenUsage;
    if (rawUsage) {
      const inputTokens = Number(rawUsage.prompt_tokens) || 0;
      const outputTokens = Number(rawUsage.completion_tokens) || 0;
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
        estimated_cost: calculateCost(inputTokens, outputTokens, usedModel),
        is_estimated: true,
        retry_token_overhead: 0,
        model: usedModel,
      };
    }

    console.log(`[gateway] ${agentName} → ${usedModel} (${usage.input_tokens}+${usage.output_tokens} tokens, $${usage.estimated_cost.toFixed(4)})`);
    return { output, usage };

  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenRouter invocation timed out (180s) for ${agentName}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
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
      const model = data?.["model"] ?? data?.["result"]?.["model"];
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

// ── Main export — routes to OpenRouter or OpenClaw Gateway ──────────────────

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
