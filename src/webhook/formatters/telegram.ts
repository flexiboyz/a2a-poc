/**
 * Telegram webhook formatter — formats pipeline events as Telegram MarkdownV2 messages.
 */

const EVENT_ICONS: Record<string, string> = {
  "step-started": "▶️",
  "step-completed": "✅",
  "step-failed": "❌",
  "step-escalated": "⚠️",
  "step-input-required": "❓",
  "pipeline-completed": "🎉",
  "pipeline-failed": "💥",
  "pipeline-suggestion": "💡",
};

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function formatTelegram(eventType: string, data: any, runId: string): Record<string, any> {
  const icon = EVENT_ICONS[eventType] ?? "📌";
  const agent = data.agent ?? "unknown";
  const shortRunId = runId.slice(0, 8);

  let text: string;

  switch (eventType) {
    case "step-started":
      text = `${icon} *Step started*: ${escapeMarkdown(agent)} \\(run \`${shortRunId}\`\\)`;
      break;
    case "step-completed":
      text = `${icon} *${escapeMarkdown(agent)}* completed \\(run \`${shortRunId}\`\\)`;
      break;
    case "step-failed":
      text = `${icon} *${escapeMarkdown(agent)}* failed \\(run \`${shortRunId}\`\\)\n${escapeMarkdown(String(data.error ?? "").slice(0, 200))}`;
      break;
    case "step-escalated":
    case "step-input-required":
      text = `${icon} *${escapeMarkdown(agent)}* needs input \\(run \`${shortRunId}\`\\)\n${escapeMarkdown(String(data.question ?? "").slice(0, 300))}`;
      break;
    case "pipeline-completed":
      text = `${icon} *Pipeline completed* \\(run \`${shortRunId}\`\\)`;
      break;
    case "pipeline-failed":
      text = `${icon} *Pipeline failed* \\(run \`${shortRunId}\`\\)\n${escapeMarkdown(String(data.error ?? "").slice(0, 200))}`;
      break;
    case "pipeline-suggestion":
      text = `${icon} *Suggestion* \\(run \`${shortRunId}\`\\)\n${escapeMarkdown(String(data.suggestion ?? "").slice(0, 300))}`;
      break;
    default:
      text = `${icon} *${escapeMarkdown(eventType)}* \\(run \`${shortRunId}\`\\)`;
  }

  return {
    parse_mode: "MarkdownV2",
    text,
  };
}
