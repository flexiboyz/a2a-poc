/**
 * A2A Agent Server — POC based on official @a2a-js/sdk README
 *
 * Flow: submitted → working → completed (or input-required → working → completed)
 */

import express from "express";
import { v4 as uuidv4 } from "uuid";
import { AgentCard, Message, AGENT_CARD_PATH } from "@a2a-js/sdk";
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

const PORT = 4000;

// ── Agent Card ─────────────────────────────────────────────────────────────

const agentCard: AgentCard = {
  name: "poc-agent",
  description: "A2A proof-of-concept agent — echoes tasks with state transitions",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: `http://localhost:${PORT}/a2a/jsonrpc`,
  skills: [
    {
      id: "analyze",
      name: "Analyze",
      description: "Analyzes a topic and produces a short report",
      tags: ["analysis"],
    },
  ],
  capabilities: {
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

// ── Agent Executor ─────────────────────────────────────────────────────────

class PocExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const userMessage = requestContext.userMessage;
    const text =
      userMessage?.parts
        ?.map((p: any) => ("text" in p ? p.text : ""))
        .join(" ")
        .trim() ?? "(no input)";

    console.log(`[agent] Received: "${text}"`);
    console.log(`[agent] → working`);

    // Simulate work
    await sleep(2000);

    // Build response
    const response: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      parts: [
        {
          kind: "text",
          text: `## Analysis Report\n\nTopic: ${text}\n\nConclusion: A2A lifecycle transitions work correctly.\nStates visited: submitted → working → completed`,
        },
      ],
      contextId: requestContext.contextId,
    };

    eventBus.publish(response);
    eventBus.finished();
    console.log(`[agent] → completed ✅`);
  }

  cancelTask = async (): Promise<void> => {
    console.log(`[agent] Task cancelled`);
  };
}

// ── Server Setup ───────────────────────────────────────────────────────────

const executor = new PocExecutor();
const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  executor,
);

const app = express();

app.use(
  `/${AGENT_CARD_PATH}`,
  agentCardHandler({ agentCardProvider: requestHandler }),
);
app.use(
  "/a2a/jsonrpc",
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }),
);
app.use(
  "/a2a/rest",
  restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
);

app.listen(PORT, () => {
  console.log(`[a2a-server] Agent running on http://localhost:${PORT}`);
  console.log(
    `[a2a-server] Agent card: http://localhost:${PORT}/${AGENT_CARD_PATH}`,
  );
  console.log(
    `[a2a-server] JSON-RPC: http://localhost:${PORT}/a2a/jsonrpc`,
  );
  console.log(`[a2a-server] REST: http://localhost:${PORT}/a2a/rest`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
