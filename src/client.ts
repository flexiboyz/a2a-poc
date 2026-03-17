/**
 * A2A Client — sends a task to the POC agent and tracks lifecycle
 */

import { A2AClient } from "@a2a-js/sdk/client";

const AGENT_CARD_URL = "http://localhost:4000/.well-known/agent-card.json";

async function main() {
  console.log("[client] Discovering agent...");
  const client = await A2AClient.fromCardUrl(AGENT_CARD_URL);
  console.log("[client] Agent found:", client.agentCard.name);

  // ── Test 1: Simple task (no input-required) ──────────────────────────────
  console.log("\n═══ Test 1: Simple task ═══");
  const response1 = await client.sendMessage({
    message: {
      role: "user",
      parts: [{ type: "text", text: "Analyze the feasibility of A2A for multi-agent pipelines" }],
    },
  });

  console.log("[client] Task created:", response1.id);
  console.log("[client] Status:", response1.status?.state);

  // Poll until completed
  await pollUntilDone(client, response1.id!);

  // ── Test 2: Task with input-required (contains "?") ──────────────────────
  console.log("\n═══ Test 2: Task with input-required ═══");
  const response2 = await client.sendMessage({
    message: {
      role: "user",
      parts: [{ type: "text", text: "Should we migrate our pipeline to A2A?" }],
    },
  });

  console.log("[client] Task created:", response2.id);
  console.log("[client] Status:", response2.status?.state);

  // Poll — should hit input-required
  await pollUntilDone(client, response2.id!, async (status: string) => {
    if (status === "input-required") {
      console.log("[client] Agent needs input! Sending reply...");
      await client.sendMessage({
        message: {
          role: "user",
          parts: [{ type: "text", text: "Yes, we want to keep Supabase as state store but use A2A for lifecycle events" }],
          taskId: response2.id!,
        },
      });
    }
  });

  console.log("\n[client] All tests passed ✅");
}

async function pollUntilDone(
  client: A2AClient,
  taskId: string,
  onStatusChange?: (status: string) => Promise<void>,
): Promise<void> {
  const maxPolls = 30;
  let lastStatus = "";

  for (let i = 0; i < maxPolls; i++) {
    await sleep(500);

    const task = await client.getTask({ id: taskId });
    const status = task.status?.state ?? "unknown";

    if (status !== lastStatus) {
      console.log(`[client] Status: ${lastStatus || "(initial)"} → ${status}`);
      lastStatus = status;
      if (onStatusChange) await onStatusChange(status);
    }

    if (status === "completed") {
      const artifacts = task.artifacts ?? [];
      for (const artifact of artifacts) {
        for (const part of artifact.parts ?? []) {
          if ("text" in part) console.log(`[client] Artifact:\n${part.text}`);
        }
      }
      return;
    }

    if (status === "failed") {
      console.error("[client] Task failed:", task.status?.message);
      return;
    }
  }

  console.error("[client] Timeout — task did not complete in time");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
