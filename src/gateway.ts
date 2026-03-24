/**
 * Shared OpenClaw Gateway invocation with token/cost tracking.
 *
 * Extracts token usage from gateway response metadata when available.
 * Falls back to character-based estimation when metadata is absent.
 */

const GATEWAY_URL = process.env["OPENCLAW_GATEWAY_URL"] ?? "http://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env["OPENCLAW_GATEWAY_TOKEN"] ?? "";

// ── Model pricing (per 1M tokens) ────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3-5-20241022": { input: 1.0, output: 5.0 },
  default: { input: 3.0, output: 15.0 },
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  is_estimated: boolean;
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

// ── Gateway invocation ──────────────────────────────────────────────────────

export async function invokeGateway(task: string): Promise<GatewayResult> {
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

    // Try to extract token usage from gateway response metadata
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

export function accumulateUsage(base: TokenUsage, additional: TokenUsage): TokenUsage {
  return {
    input_tokens: base.input_tokens + additional.input_tokens,
    output_tokens: base.output_tokens + additional.output_tokens,
    total_tokens: base.total_tokens + additional.total_tokens,
    estimated_cost: base.estimated_cost + additional.estimated_cost,
    is_estimated: base.is_estimated || additional.is_estimated,
  };
}

export function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0, is_estimated: true };
}
