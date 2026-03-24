/**
 * Slack webhook formatter — formats pipeline events as Slack Block Kit payloads.
 */

const EVENT_ICONS: Record<string, string> = {
  "step-started": ":arrow_forward:",
  "step-completed": ":white_check_mark:",
  "step-failed": ":x:",
  "step-escalated": ":warning:",
  "step-input-required": ":question:",
  "pipeline-completed": ":tada:",
  "pipeline-failed": ":boom:",
  "pipeline-suggestion": ":bulb:",
};

export function formatSlack(eventType: string, data: any, runId: string): Record<string, any> {
  const icon = EVENT_ICONS[eventType] ?? ":pushpin:";
  const agent = data.agent ?? "unknown";
  const shortRunId = runId.slice(0, 8);

  let headerText: string;
  let detail: string | null = null;

  switch (eventType) {
    case "step-started":
      headerText = `${icon} Step started: *${agent}*`;
      break;
    case "step-completed":
      headerText = `${icon} *${agent}* completed`;
      break;
    case "step-failed":
      headerText = `${icon} *${agent}* failed`;
      detail = String(data.error ?? "").slice(0, 200);
      break;
    case "step-escalated":
    case "step-input-required":
      headerText = `${icon} *${agent}* needs input`;
      detail = String(data.question ?? "").slice(0, 300);
      break;
    case "pipeline-completed":
      headerText = `${icon} Pipeline completed`;
      break;
    case "pipeline-failed":
      headerText = `${icon} Pipeline failed`;
      detail = String(data.error ?? "").slice(0, 200);
      break;
    case "pipeline-suggestion":
      headerText = `${icon} Suggestion received`;
      detail = String(data.suggestion ?? "").slice(0, 300);
      break;
    default:
      headerText = `${icon} ${eventType}`;
  }

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${headerText}\n_Run \`${shortRunId}\`_` },
    },
  ];

  if (detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: detail },
    });
  }

  return { blocks };
}
