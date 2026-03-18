/**
 * Test script for Cipher A2A agent
 *
 * Usage: npx tsx src/test-cipher.ts
 * (requires the server to be running on port 4000)
 */

import { A2AClient } from "@a2a-js/sdk/client";
import { v4 as uuidv4 } from "uuid";

const BASE_URL = "http://localhost:4000";

async function main() {
  console.log("=== Cipher A2A Agent Test ===\n");

  // Step 1: Fetch agent card
  const cardUrl = `${BASE_URL}/cipher/.well-known/agent-card.json`;
  console.log(`[1] Fetching agent card: ${cardUrl}`);

  const cardRes = await fetch(cardUrl);
  if (!cardRes.ok) {
    console.error(`❌ Failed to fetch agent card: ${cardRes.status}`);
    process.exit(1);
  }

  const card = await cardRes.json();
  console.log(`✅ Agent: ${card.name}`);
  console.log(`   Skills: ${card.skills.map((s: any) => s.id).join(", ")}`);
  console.log(`   URL: ${card.url}\n`);

  // Step 2: Send A2A message
  console.log("[2] Sending A2A message via JSON-RPC...");

  const client = await A2AClient.fromCardUrl(cardUrl);
  const response = await client.sendMessage({
    message: {
      messageId: uuidv4(),
      role: "user",
      parts: [{
        kind: "text",
        text: `## Task Context

Analyze the following small codebase requirement:
- Project: A2A POC
- Objective: Add a health-check endpoint to the Express server
- Current files: server.ts, agents/create-agent.ts

Provide your structured analysis.`,
      }],
      kind: "message",
    },
  });

  // Step 3: Check response
  const result = (response as any).result ?? response;
  console.log("\n[3] Response received:");
  console.log(`    Kind: ${result.kind}`);

  if (result.kind === "task" && result.status?.state === "failed") {
    const errorText = result.status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") || "unknown error";
    console.log(`❌ Agent failed: ${errorText}`);
    process.exit(1);
  }

  const output =
    result.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") ||
    result.status?.message?.parts?.map((p: any) => ("text" in p ? p.text : "")).join("") ||
    "(no output)";

  console.log(`✅ Output (${output.length} chars):\n`);
  console.log(output.slice(0, 500));
  if (output.length > 500) console.log(`\n... (${output.length - 500} more chars)`);

  console.log("\n=== Test passed ===");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
