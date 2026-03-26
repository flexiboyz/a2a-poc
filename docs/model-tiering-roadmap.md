# Model Tiering — Roadmap

_Status: Future optimization — NOT for now_
_Date: 2026-03-26_

---

## Concept

Route agents to different models based on task complexity (as determined by WorkflowMaster).
Goal: optimize costs without sacrificing quality on complex tasks.

## Proposed Tiers

| Complexity | Assembler Model | Estimated Cost |
|---|---|---|
| **low** | Sonnet 4.5 | ~$0.01-0.05/task |
| **medium** | Sonnet 4.6 | ~$0.05-0.20/task |
| **high** | Opus 4.6 | ~$0.20-1.00/task |

Cipher and Sentinel can stay on Gemini 2.5 Pro regardless — their workload is analysis/review, not heavy code generation.

## How It Would Work

1. WorkflowMaster qualifies task → outputs `complexity: low | medium | high`
2. Orchestrator reads complexity before spawning Assembler
3. Overrides `MODEL_ASSEMBLER` per-task based on tier
4. Gateway `invokeGateway()` already accepts `agentName` for model routing — extend to accept per-invocation model override

## Implementation Notes

- The `AGENT_MODELS` map in `gateway.ts` is currently static (env vars)
- Need a `modelOverride` parameter in `invokeGateway()` that takes priority over the map
- Orchestrator in `server.ts` → `executeAgent()` would pass the override based on SM output
- Fallback: if no complexity in SM output, use default model

## Considerations

- Monitor quality difference between tiers before committing
- Track cost per complexity tier in run_steps DB (already has `estimated_cost`)
- Low complexity tasks are the bulk (60-70%) → biggest cost savings there
- Could also tier Sentinel: Gemini Flash for low, Gemini Pro for high

## Not Doing Yet Because

- Pipeline is still being validated end-to-end
- Need more data on actual cost distribution
- Premature optimization — get it working first, optimize later
