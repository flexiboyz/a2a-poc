/**
 * Factory to create A2A agent servers — each agent just says hello
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

interface AgentDef {
  name: string;
  emoji: string;
  port: number;
  skill: string;
  description: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createAgent(def: AgentDef) {
  const card: AgentCard = {
    name: def.name,
    description: def.description,
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `http://localhost:${def.port}/a2a/jsonrpc`,
    skills: [{ id: def.skill, name: def.skill, description: def.description, tags: [def.skill] }],
    capabilities: { pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  class Executor implements AgentExecutor {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const text = ctx.userMessage?.parts?.map((p: any) => ("text" in p ? p.text : "")).join(" ").trim() ?? "";
      console.log(`[${def.emoji} ${def.name}] Received: "${text}"`);

      // Simulate thinking
      await sleep(1000 + Math.random() * 2000);

      const response: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{ kind: "text", text: `${def.emoji} Salut, je suis **${def.name}** ! J'ai bien reçu ta tâche.` }],
        contextId: ctx.contextId,
      };

      bus.publish(response);
      bus.finished();
      console.log(`[${def.emoji} ${def.name}] → completed ✅`);
    }
    cancelTask = async () => {};
  }

  const app = express();
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new Executor());

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return { app, card, def };
}
