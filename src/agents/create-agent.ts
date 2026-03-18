/**
 * Factory to create A2A agent routers — all agents share one Express server
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { AgentCard, Message, AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { TaskStatusUpdateEvent, Task } from "@a2a-js/sdk";
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
  /** If true, this agent will pause and request user input before completing */
  requiresInput?: boolean;
  /** If true, this agent always fails. If a number (0-1), probability of failure */
  alwaysFails?: boolean | number;
  /** If true, this agent asks whether to re-run the pipeline */
  askRerun?: boolean;
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

      // Check if this is a resumed execution (user replied to input-required)
      const isResume = ctx.task && ctx.task.status?.state === "input-required";

      if (isResume) {
        // User has replied — continue with their input
        console.log(`[${def.emoji} ${def.name}] Resuming after user input`);
        await sleep(500 + Math.random() * 1000);

        const response: Message = {
          kind: "message",
          messageId: uuidv4(),
          role: "agent",
          parts: [{
            kind: "text",
            text: `${def.emoji} **${def.name}** received your input: "${text.slice(0, 200)}"\n\n✅ Proceeding with the task based on your confirmation.`,
          }],
          contextId: ctx.contextId,
        };
        bus.publish(response);
        bus.finished();
        console.log(`[${def.emoji} ${def.name}] → completed after user input ✅`);
        return;
      }

      // Normal execution
      await sleep(1000 + Math.random() * 2000);

      // If this agent can fail (deterministic or random)
      const failChance = typeof def.alwaysFails === "number" ? def.alwaysFails : (def.alwaysFails ? 1 : 0);
      const shouldFail = failChance > 0 && Math.random() < failChance;
      if (shouldFail) {
        console.log(`[${def.emoji} ${def.name}] → FAILING (${Math.round(failChance * 100)}% chance)`);

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
              parts: [{
                kind: "text",
                text: `${def.emoji} **${def.name}** crashed!\n\n💥 Fatal error: something went terribly wrong. The agent could not complete the task.`,
              }],
              contextId: ctx.contextId,
            },
            timestamp: new Date().toISOString(),
          },
          history: [],
        };

        bus.publish(task);
        bus.finished();
        return;
      }

      // If this agent requires input, pause and ask
      if (def.requiresInput) {
        console.log(`[${def.emoji} ${def.name}] → requesting user input (input-required)`);

        // Publish a Task object with input-required status
        // This tells the SDK to return a Task (not a Message) to the client
        const task: Task = {
          kind: "task",
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state: "input-required",
            message: {
              kind: "message",
              messageId: uuidv4(),
              role: "agent",
              parts: [{
                kind: "text",
                text: `${def.emoji} **${def.name}** needs your input!\n\nI've analyzed the topic and found something that needs your decision before I can proceed.\n\n**Question:** Should I take the bold approach or the safe approach? Reply with your choice.`,
              }],
              contextId: ctx.contextId,
            },
            timestamp: new Date().toISOString(),
          },
          history: [],
        };

        bus.publish(task);
        bus.finished();
        return;
      }

      // If this is the rerun agent, ask whether to relaunch
      if (def.askRerun) {
        console.log(`[${def.emoji} ${def.name}] → asking for rerun`);

        const task: Task = {
          kind: "task",
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: {
            state: "input-required",
            message: {
              kind: "message",
              messageId: uuidv4(),
              role: "agent",
              parts: [{
                kind: "text",
                text: `${def.emoji} **${def.name}** — Pipeline finished!\n\n✅ All agents completed successfully.\n\n**Want to re-run this pipeline?** Reply "yes" to relaunch or "no" to finish.`,
              }],
              contextId: ctx.contextId,
            },
            timestamp: new Date().toISOString(),
          },
          history: [],
        };

        bus.publish(task);
        bus.finished();
        return;
      }

      // Standard response (no input required)
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
