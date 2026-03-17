/**
 * A2A Client — sends a task to the POC agent and tracks lifecycle
 * Based on official @a2a-js/sdk README
 */

import { ClientFactory } from "@a2a-js/sdk/client";
import { Message, MessageSendParams } from "@a2a-js/sdk";
import { v4 as uuidv4 } from "uuid";

const AGENT_BASE_URL = "http://localhost:4000";

async function main() {
  console.log("[client] Discovering agent...");
  const factory = new ClientFactory();
  const client = await factory.createFromUrl(AGENT_BASE_URL);
  console.log("[client] Agent found ✅");

  // ── Test 1: Simple task ──────────────────────────────────────────────────
  console.log("\n═══ Test 1: Simple task ═══");

  const sendParams: MessageSendParams = {
    message: {
      messageId: uuidv4(),
      role: "user",
      parts: [
        {
          kind: "text",
          text: "Analyze the feasibility of A2A for multi-agent pipelines",
        },
      ],
      kind: "message",
    },
  };

  try {
    const response = await client.sendMessage(sendParams);
    
    // Response can be a Message (direct) or a Task (async)
    if ("kind" in response && response.kind === "message") {
      const msg = response as Message;
      console.log("[client] Got direct response:");
      for (const part of msg.parts ?? []) {
        if ("text" in part) console.log(part.text);
      }
    } else {
      console.log("[client] Got task response:", JSON.stringify(response, null, 2));
    }
  } catch (e) {
    console.error("[client] Error:", e);
  }

  console.log("\n[client] Test complete ✅");
}

main().catch(console.error);
