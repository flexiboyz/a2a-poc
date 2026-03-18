/**
 * Factory to create A2A agent routers — all agents share one Express server
 */

import { Router } from "express";
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

export interface AgentDef {
  name: string;
  emoji: string;
  skill: string;
  description: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Creates an Express Router for a single A2A agent.
 * Mount it on the main app: app.use("/spark", createAgentRouter(def, baseUrl))
 */
export function createAgentRouter(def: AgentDef, baseUrl: string): Router {
  const slug = def.name.toLowerCase();

  const card: AgentCard = {
    name: def.name,
    description: def.description,
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/${slug}/a2a/jsonrpc`,
    skills: [{ id: def.skill, name: def.skill, description: def.description, tags: [def.skill] }],
    capabilities: { pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  class Executor implements AgentExecutor {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const text = ctx.userMessage?.parts?.map((p: any) => ("text" in p ? p.text : "")).join(" ").trim() ?? "";
      console.log(`[${def.emoji} ${def.name}] Received: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);

      // Simulate thinking
      await sleep(1000 + Math.random() * 2000);

      const response: Message = {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: [{
          kind: "text",
          text: `${def.emoji} **${def.name}** here!\n\nI received: "${text.slice(0, 200)}${text.length > 200 ? "..." : ""}"\n\nMy take as a ${def.description.toLowerCase()}: This is interesting. I'd ${def.skill === "brainstorm" ? "explore bold new angles" : def.skill === "validate" ? "check if this is actually buildable" : "look for what could go wrong"} and pass my findings to the next agent.`,
        }],
        contextId: ctx.contextId,
      };

      bus.publish(response);
      bus.finished();
      console.log(`[${def.emoji} ${def.name}] → completed ✅`);
    }
    cancelTask = async () => {};
  }

  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new Executor());
  const router = Router();

  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  router.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  return router;
}
