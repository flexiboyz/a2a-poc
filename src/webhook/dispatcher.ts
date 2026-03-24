/**
 * Webhook dispatcher — sends pipeline events to external webhook URLs.
 * Hooks into broadcast() via dispatchWebhookEvent().
 */

import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { formatTelegram } from "./formatters/telegram.js";
import { formatSlack } from "./formatters/slack.js";
import { formatGeneric } from "./formatters/generic.js";

export interface WebhookConfig {
  id: string;
  pipeline_id: string | null;
  channel_type: "telegram" | "slack" | "generic";
  webhook_url: string;
  event_filters: string[] | null;
  active: number;
}

interface QueuedEvent {
  configId: string;
  webhookUrl: string;
  channelType: string;
  runId: string;
  eventType: string;
  payload: any;
}

const BATCH_WINDOW_MS = 2000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

const CRITICAL_EVENTS = new Set([
  "pipeline-failed",
  "step-failed",
  "step-escalated",
  "step-input-required",
]);

const batchQueue = new Map<string, { events: QueuedEvent[]; timer: ReturnType<typeof setTimeout> }>();

function formatPayload(channelType: string, eventType: string, data: any, runId: string): any {
  switch (channelType) {
    case "telegram": return formatTelegram(eventType, data, runId);
    case "slack": return formatSlack(eventType, data, runId);
    default: return formatGeneric(eventType, data, runId);
  }
}

async function deliverWebhook(
  configId: string, webhookUrl: string, channelType: string,
  runId: string, eventType: string, payload: any,
): Promise<void> {
  const deliveryId = uuidv4();
  const formattedPayload = formatPayload(channelType, eventType, payload, runId);

  db.prepare(`INSERT INTO webhook_deliveries (id, webhook_config_id, run_id, event_type, payload, status)
    VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(deliveryId, configId, runId, eventType, JSON.stringify(formattedPayload));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formattedPayload),
        signal: AbortSignal.timeout(10_000),
      });
      db.prepare(`UPDATE webhook_deliveries SET status = 'delivered', http_status = ?, retry_count = ?, delivered_at = datetime('now') WHERE id = ?`)
        .run(res.status, attempt, deliveryId);
      return;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) {
        db.prepare(`UPDATE webhook_deliveries SET status = 'failed', retry_count = ?, error = ? WHERE id = ?`)
          .run(attempt, errorMsg, deliveryId);
        console.error(`[webhook] delivery ${deliveryId} failed after ${MAX_RETRIES} retries: ${errorMsg}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * Math.pow(2, attempt)));
    }
  }
}

function flushBatch(key: string): void {
  const batch = batchQueue.get(key);
  if (!batch || batch.events.length === 0) { batchQueue.delete(key); return; }
  const events = batch.events.splice(0);
  batchQueue.delete(key);
  for (const evt of events) {
    deliverWebhook(evt.configId, evt.webhookUrl, evt.channelType, evt.runId, evt.eventType, evt.payload)
      .catch(err => console.error(`[webhook] dispatch error:`, err));
  }
}

export function dispatchWebhookEvent(runId: string, eventType: string, data: any): void {
  const run = db.prepare("SELECT pipeline_id FROM runs WHERE id = ?").get(runId) as { pipeline_id: string } | undefined;
  if (!run) return;

  const configs = db.prepare(
    `SELECT * FROM webhook_configs WHERE active = 1 AND (pipeline_id = ? OR pipeline_id IS NULL)`
  ).all(run.pipeline_id) as WebhookConfig[];

  for (const config of configs) {
    if (config.event_filters) {
      const filters = typeof config.event_filters === "string"
        ? JSON.parse(config.event_filters) as string[]
        : config.event_filters;
      if (!filters.includes(eventType)) continue;
    }

    if (CRITICAL_EVENTS.has(eventType)) {
      deliverWebhook(config.id, config.webhook_url, config.channel_type, runId, eventType, data)
        .catch(err => console.error(`[webhook] dispatch error:`, err));
      continue;
    }

    const batchKey = `${config.id}:${runId}`;
    const existing = batchQueue.get(batchKey);
    if (existing) {
      existing.events.push({ configId: config.id, webhookUrl: config.webhook_url, channelType: config.channel_type, runId, eventType, payload: data });
    } else {
      const timer = setTimeout(() => flushBatch(batchKey), BATCH_WINDOW_MS);
      batchQueue.set(batchKey, { events: [{ configId: config.id, webhookUrl: config.webhook_url, channelType: config.channel_type, runId, eventType, payload: data }], timer });
    }
  }
}
