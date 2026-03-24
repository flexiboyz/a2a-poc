/**
 * A2A SSE Client — wraps sendMessageStream() with reconnection logic.
 *
 * Replaces blocking sendMessage() calls with event-driven SSE streams.
 * Uses exponential backoff (1–16s, max 5 retries) via resubscribeTask().
 */

import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, MessageSendParams, TaskIdParams } from "@a2a-js/sdk";

// ── Types ────────────────────────────────────────────────────────────────────

export type A2AStreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface StreamCallbacks {
  onStatusUpdate?: (event: TaskStatusUpdateEvent) => void;
  onArtifactUpdate?: (event: TaskArtifactUpdateEvent) => void;
  onMessage?: (message: Message) => void;
  onTask?: (task: Task) => void;
}

export interface StreamResult {
  /** Final message or task from the stream */
  result: Message | Task;
  /** All events received during the stream */
  events: A2AStreamEvent[];
}

interface ReconnectConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RECONNECT: ReconnectConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, config: ReconnectConfig): number {
  return Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs);
}

function isStatusUpdate(event: A2AStreamEvent): event is TaskStatusUpdateEvent {
  return "kind" in event && event.kind === "status-update";
}

function isArtifactUpdate(event: A2AStreamEvent): event is TaskArtifactUpdateEvent {
  return "kind" in event && event.kind === "artifact-update";
}

function isMessage(event: A2AStreamEvent): event is Message {
  return "kind" in event && event.kind === "message";
}

function isTask(event: A2AStreamEvent): event is Task {
  return "kind" in event && event.kind === "task";
}

// ── Core SSE stream consumer ─────────────────────────────────────────────────

/**
 * Sends a message via SSE stream and collects events until completion.
 * Returns the final result (Message or Task) with all intermediate events.
 *
 * On SSE disconnect, reconnects via resubscribeTask() with exponential backoff.
 */
export async function sendMessageStream(
  client: A2AClient,
  params: MessageSendParams,
  callbacks?: StreamCallbacks,
  reconnectConfig: ReconnectConfig = DEFAULT_RECONNECT,
): Promise<StreamResult> {
  const events: A2AStreamEvent[] = [];
  let lastResult: Message | Task | null = null;
  let lastTaskId: string | null = null;

  // Initial stream
  try {
    const stream = client.sendMessageStream(params);
    for await (const event of stream) {
      events.push(event);
      lastResult = dispatchEvent(event, callbacks, lastResult);

      // Track task ID for potential reconnection
      if (isTask(event)) {
        lastTaskId = event.id;
      } else if (isStatusUpdate(event)) {
        lastTaskId = event.taskId;
      }

      // If we got a terminal state, we're done
      if (isTerminal(event)) {
        return { result: lastResult!, events };
      }
    }
  } catch (err) {
    // Stream disconnected — attempt reconnection if we have a task ID
    if (lastTaskId) {
      console.log(`[a2a-client] SSE disconnected, attempting reconnection for task ${lastTaskId}`);
      const reconnectResult = await reconnect(client, lastTaskId, events, callbacks, reconnectConfig);
      if (reconnectResult) return reconnectResult;
    }
    throw err;
  }

  // Stream ended normally — return last result
  if (lastResult) {
    return { result: lastResult, events };
  }

  throw new Error("SSE stream ended without producing a result");
}

// ── Reconnection ─────────────────────────────────────────────────────────────

async function reconnect(
  client: A2AClient,
  taskId: string,
  events: A2AStreamEvent[],
  callbacks: StreamCallbacks | undefined,
  config: ReconnectConfig,
): Promise<StreamResult | null> {
  let lastResult: Message | Task | null = null;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    const delay = backoffDelay(attempt, config);
    console.log(`[a2a-client] Reconnect attempt ${attempt + 1}/${config.maxRetries} in ${delay}ms`);
    await sleep(delay);

    try {
      const stream = client.resubscribeTask({ id: taskId } as TaskIdParams);
      for await (const event of stream) {
        events.push(event);
        lastResult = dispatchEvent(event, callbacks, lastResult);

        if (isTerminal(event)) {
          console.log(`[a2a-client] Reconnected successfully, task ${taskId} reached terminal state`);
          return { result: lastResult!, events };
        }
      }

      // Stream ended without terminal event — try again
      if (lastResult) {
        return { result: lastResult, events };
      }
    } catch (err) {
      console.log(`[a2a-client] Reconnect attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.error(`[a2a-client] Reconnection failed after ${config.maxRetries} attempts for task ${taskId}`);
  return null;
}

// ── Event dispatch ───────────────────────────────────────────────────────────

function dispatchEvent(
  event: A2AStreamEvent,
  callbacks: StreamCallbacks | undefined,
  lastResult: Message | Task | null,
): Message | Task {
  if (isStatusUpdate(event)) {
    callbacks?.onStatusUpdate?.(event);
    // Keep the last result — status updates don't replace it
    return lastResult ?? ({} as Task);
  }

  if (isArtifactUpdate(event)) {
    callbacks?.onArtifactUpdate?.(event);
    return lastResult ?? ({} as Task);
  }

  if (isMessage(event)) {
    callbacks?.onMessage?.(event);
    return event;
  }

  if (isTask(event)) {
    callbacks?.onTask?.(event);
    return event;
  }

  return lastResult ?? ({} as Task);
}

/** Check if an event represents a terminal state (completed, failed, input-required) */
function isTerminal(event: A2AStreamEvent): boolean {
  if (isTask(event)) {
    const state = event.status?.state;
    return state === "completed" || state === "failed" || state === "input-required";
  }

  if (isStatusUpdate(event)) {
    const state = event.status?.state;
    return state === "completed" || state === "failed" || state === "input-required";
  }

  // Messages are always terminal (direct response, no task lifecycle)
  if (isMessage(event)) {
    return true;
  }

  return false;
}
