# A2A Pipeline v2 — Architecture Spec

_Date: 2026-03-24 | Status: Design | Author: Rone + RockerClaw_

---

## 1. Overview

Structured agent-to-agent pipeline using YAML contracts validated by Zod schemas. Each agent receives accumulated context from previous steps and produces a validated YAML output. The pipeline is orchestrated via callbacks triggered by A2A task state changes.

### Core Principles

- **YAML contracts** — Every agent input/output is structured YAML, not free text
- **Zod validation** — Every output is validated against a per-agent schema. 3 retries max → fail
- **Accumulated context** — Each agent receives ALL previous agent YAMLs (option B)
- **Callbacks over hardcoded logic** — `on_done`, `on_fail`, `on_change_request`, `on_await_user` replace watcher if/else chains
- **Pipeline fixed by default** — SM decides pipeline upfront. Agents can suggest changes but can't modify it autonomously

---

## 2. YAML Contract Structure

### 2.1 Common Header (all agents)

```yaml
agent: "AgentName"
task_seq: 287
iteration: 1
status: "done" | "fail" | "waiting_user"
waiting_reason: null  # only when status = waiting_user

# Pipeline awareness
out_of_scope: []              # items that need separate tickets
pipeline_suggestion: null      # optional: propose pipeline modification

# Agent-specific output
output:
  # ... varies per agent, validated by agent's Zod schema
```

### 2.2 Pipeline Suggestion (when needed)

```yaml
pipeline_suggestion:
  action: "insert_after_current"  # insert_after_current | insert_before_next | replace_next
  agent: "Prism"
  reason: "Task has UI component not anticipated by SM"
```

When present → pipeline pauses → notification sent → Rone approves/rejects.

---

## 3. Per-Agent YAML Schemas

### 3.1 WorkflowMaster (SM) 🏃

First agent. Qualifies the task and defines the pipeline.

**Input:** Task title + body (defined by Rone, enriched by buildBrief)

```yaml
agent: "WorkflowMaster"
task_seq: 287
iteration: 1
status: "done"

output:
  qualification:
    complexity: "low" | "medium" | "high"
    type: "code" | "design" | "legal" | "mixed"
    estimated_agents: 3
  pipeline: ["Cipher", "Assembler", "Sentinel"]
  branch: "dev"
  acceptance_criteria:
    - "Route /legal exists with sub-navigation"
    - "Track Ownership page has complete legal text"
    - "Copyright Dispute page has takedown process"
  context_notes: "NEARD legal section. EU Copyright Directive applies."
```

### 3.2 Cipher (Analysis) 🔍

Analyzes the codebase against the task requirements.

```yaml
agent: "Cipher"
task_seq: 287
iteration: 1
status: "done"

output:
  summary: "Create /legal section with 2 sub-pages"
  files_impacted:
    - path: "app/legal/page.tsx"
      action: "create"
      reason: "Legal landing page with navigation"
    - path: "app/legal/track-ownership/page.tsx"
      action: "create"
      reason: "Track ownership policy page"
  risks:
    - level: "low"
      description: "No breaking changes to existing routes"
  dependencies: []
  recommendations:
    - "Follow existing page pattern from /wtf-is-neard"
    - "Add Legal link to drawer in header.tsx"
  acceptance_criteria_check:
    - criteria: "Route /legal exists"
      met: false
      notes: "To be created by Assembler"
```

### 3.3 Prism (UX Design) 🌈

UI specs and user flows. Optional — SM includes when task has UI component.

```yaml
agent: "Prism"
task_seq: 287
iteration: 1
status: "done"

output:
  summary: "Clean legal page layout with tab navigation"
  components:
    - name: "LegalLayout"
      description: "Shared layout with tab nav between sub-pages"
      props: ["activeTab: string", "children: ReactNode"]
    - name: "LegalContent"
      description: "Markdown-rendered legal text with TOC"
      props: ["content: string"]
  user_flows:
    - name: "Access legal from drawer"
      steps:
        - "Open drawer → click Legal"
        - "Land on /legal → see tab navigation"
        - "Click Track Ownership or Copyright Dispute"
  accessibility_notes:
    - "Ensure legal text has proper heading hierarchy for screen readers"
```

### 3.4 Hammer (Legal) ⚖️

Legal content and compliance analysis. Produces external .md files referenced in output.

```yaml
agent: "Hammer"
task_seq: 287
iteration: 1
status: "done"

output:
  legal_analysis: "EU Copyright Directive 2019/790 Art. 17 applies. NEARD is OCSSP."
  draft_files:
    - path: "docs/legal/track-ownership.md"
      section: "Track Ownership"
      description: "Artist rights, responsibilities, indemnification clause"
    - path: "docs/legal/copyright-dispute.md"
      section: "Copyright Dispute"
      description: "Takedown process, counter-notice, repeat infringers"
  implementation_notes:
    - "Create /legal/track-ownership route rendering track-ownership.md"
    - "Create /legal/copyright-dispute route rendering copyright-dispute.md"
    - "Add link from upload disclaimer to /legal/track-ownership"
  open_questions:
    - "Confirm contact email: legal@neard.io"
    - "DMCA agent registration needed if targeting US users"
  sources:
    - "EU Directive 2019/790 Art. 17"
    - "EU Digital Services Act (Regulation 2022/2065)"
    - "Belgian Code of Economic Law Book XI"
```

### 3.5 Assembler (Implementation) ⚙️

Codes, creates branch, commits, opens PR.

```yaml
agent: "Assembler"
task_seq: 287
iteration: 1
status: "done"

output:
  summary: "Created legal pages with track ownership and copyright dispute content"
  branch: "feat/legal-pages"
  pull_request:
    number: 69
    url: "https://github.com/SuperstrongBE/neard/pull/69"
  commits:
    - "feat: add /legal route with tab navigation"
    - "feat: add track ownership page"
    - "feat: add copyright dispute page"
    - "feat: add Legal link to artist drawer"
  files_changed:
    - path: "app/legal/page.tsx"
      action: "created"
    - path: "app/legal/track-ownership/page.tsx"
      action: "created"
    - path: "app/legal/copyright-dispute/page.tsx"
      action: "created"
    - path: "components/header.tsx"
      action: "modified"
  build_status: "pass"
  lint_status: "pass"
```

### 3.6 Sentinel (Review) 🛡️

Reviews PR, merges or requests changes.

```yaml
agent: "Sentinel"
task_seq: 287
iteration: 1
status: "done"

output:
  verdict: "approved" | "request_changes"
  pull_request:
    number: 69
    url: "https://github.com/SuperstrongBE/neard/pull/69"
    merged: true
  summary: "Legal pages correct, well-structured, no security issues"
  files:
    - path: "app/legal/page.tsx"
      status: "accepted"
      comment: null
    - path: "components/header.tsx"
      status: "accepted"
      comment: null
  security_flags: []
  build_status: "pass"
  acceptance_criteria_check:
    - criteria: "Route /legal exists"
      met: true
    - criteria: "Track Ownership page has complete legal text"
      met: true
```

### 3.7 Bastion (Infrastructure) 🏰

Security review and infra checks. Future use.

```yaml
agent: "Bastion"
task_seq: 287
iteration: 1
status: "done"

output:
  summary: "No infrastructure changes required"
  services_checked: []
  security_review:
    - item: "No auth required for legal pages"
      risk: "none"
      recommendation: "Correct — legal pages are public"
  actions_taken: []
```

---

## 4. Callbacks

Callbacks replace the hardcoded watcher logic. Defined per pipeline or per agent.

### 4.1 Default Callbacks

```yaml
callbacks:
  on_done: "next_agent()"
  on_fail: "notify_user('Agent {agent} failed on #{task_seq}')"
  on_await_user: "notify_user('Agent {agent} waiting for input on #{task_seq}')"
  on_change_request: "call_agent('Assembler', accumulated_context)"
  on_pipeline_suggestion: "pause_and_notify_user()"
  on_validation_fail: "retry_agent(max: 3)"           # retry with full error context (Option C)
  on_validation_fail_final: "escalate_to_user"         # 3rd fail → pause + notify, user decides
```

### 4.2 Callback Flow

```
Agent completes A2A task
  → A2A state = "completed"
  → Watcher receives SSE event
  → Parse YAML output
  → Validate with Zod schema
    → If validation fails:
      → on_validation_fail → retry (inject Zod error as feedback)
      → 3 fails → on_fail
    → If validation passes:
      → Check output.status:
        → "done" + verdict "approved" → on_done
        → "done" + verdict "request_changes" → on_change_request
        → "fail" → on_fail
        → "waiting_user" → on_await_user
      → Check pipeline_suggestion:
        → If present → on_pipeline_suggestion (pause + notify)
      → Check out_of_scope:
        → If present → create_tickets(out_of_scope)
```

### 4.3 Custom Callbacks (per agent override)

```yaml
# Example: Sentinel has custom on_change_request
agents:
  Sentinel:
    callbacks:
      on_change_request: "call_agent('Assembler', {sentinel_output})"
```

---

## 5. Validation — Zod Schemas

### 5.1 Location

```
workflow/schemas/
  common.ts          # shared header schema
  workflowmaster.ts  # SM output schema
  cipher.ts          # Cipher output schema
  assembler.ts       # Assembler output schema
  sentinel.ts        # Sentinel output schema
  hammer.ts          # Hammer output schema
  prism.ts           # Prism output schema
  bastion.ts         # Bastion output schema
```

### 5.2 Validation Flow

```
1. Agent produces YAML string
2. Parse YAML → JS object
3. Validate against common header schema
4. Validate output field against agent-specific schema
5. If fail → inject Zod error message as feedback → retry
6. After 3 fails → pipeline fail + notify
```

### 5.3 Retry Feedback Format (Option C — full context)

When Zod validation fails, the agent receives all context to self-correct:

```yaml
validation_error:
  attempt: 2
  max_attempts: 3
  instruction: "Your output failed Zod validation. Fix the errors below and resubmit."
  errors:
    - path: "output.files_changed[0].action"
      expected: "'created' | 'modified' | 'deleted'"
      received: "'new'"
      fix: "Change 'new' to 'created'"
    - path: "output.build_status"
      expected: "'pass' | 'fail'"
      received: null
      fix: "Add build_status field"
  previous_output: |
    <the full YAML that failed — agent corrects from this>
```

### 5.4 3rd Fail → Escalate

After 3 failed validation attempts, the pipeline does NOT hard fail. Instead:

```yaml
callbacks:
  on_validation_fail_final: "escalate_to_user"
```

**Escalation flow:**
1. Pipeline pauses (status: `waiting_user`)
2. Notification sent to Rone with:
   - Agent name + task
   - The 3 failed outputs
   - The Zod errors for each attempt
3. Rone can:
   - **Fix manually** — edit the YAML and submit as agent output → pipeline continues
   - **Retry** — give the agent additional instructions and restart validation cycle
   - **Abort** — task → fail

---

## 6. Pipeline Execution Flow

```
┌─────────────┐
│  Rone/User   │  Creates ticket + initial input
└──────┬──────┘
       │
       ▼
┌─────────────┐
│     SM      │  Qualifies task, defines pipeline
│   🏃        │  Output: pipeline, branch, criteria
└──────┬──────┘
       │ on_done → next_agent()
       ▼
┌─────────────┐
│   Agent 1   │  (e.g. Cipher, Hammer)
│             │  Receives: SM context
└──────┬──────┘
       │ on_done → next_agent()
       ▼
┌─────────────┐
│   Agent 2   │  (e.g. Prism, Assembler)
│             │  Receives: SM + Agent 1 YAMLs
└──────┬──────┘
       │ on_done → next_agent()
       ▼
┌─────────────┐
│   Agent N   │  (e.g. Sentinel)
│             │  Receives: ALL previous YAMLs
└──────┬──────┘
       │
       ├── verdict: approved → on_done → validate_pipeline() → task done ✅
       │
       └── verdict: request_changes → on_change_request
              → call_agent('Assembler', accumulated_context)
              → max 3 iterations → fail if exceeded
```

---

## 7. Context Accumulation

Each agent receives a `context` block containing all previous outputs:

```yaml
# Injected by the spawner
pipeline_context:
  task:
    seq: 287
    title: "Legal page — Track Ownership & Copyright Dispute"
    body: "..."
  previous_agents:
    - agent: "WorkflowMaster"
      output: { ... }  # Full SM YAML
    - agent: "Cipher"
      output: { ... }  # Full Cipher YAML
    - agent: "Hammer"
      output: { ... }  # Full Hammer YAML
  current_iteration: 1
  max_iterations: 3
```

---

## 8. Pipeline Modification (A+B Model)

### Default: Pipeline Fixed

SM defines pipeline. Agents execute in order. No modifications.

### Escape Hatch: Pipeline Suggestion

Any agent can include `pipeline_suggestion` in output:

```yaml
pipeline_suggestion:
  action: "insert_after_current"
  agent: "Prism"
  reason: "Task has UI component not anticipated"
```

**What happens:**
1. Watcher detects `pipeline_suggestion`
2. Pipeline pauses
3. Notification sent to Rone with suggestion details
4. Rone approves → pipeline updated, execution continues
5. Rone rejects → suggestion logged, pipeline continues as-is

### Out of Scope → New Tickets

```yaml
out_of_scope:
  - title: "Add disclaimer link in upload form"
    description: "Upload form needs checkbox linking to /legal/track-ownership"
    priority: "medium"
```

Watcher auto-creates backlog tickets for each item.

---

## 9. A2A Integration Points

### 9.1 Agent Server

Each agent is an A2A-compliant server:
- Receives tasks via `tasks/send`
- Reports status via task state (`submitted` → `working` → `completed` | `failed`)
- Output is the YAML contract (in task artifact)

### 9.2 Watcher as A2A Client

The watcher subscribes to agent task updates via SSE:
- `completed` → parse YAML → validate Zod → trigger callback
- `failed` → trigger `on_fail` callback
- No polling — event-driven

### 9.3 Task Artifact

The YAML output is stored as an A2A task artifact:

```json
{
  "parts": [
    {
      "type": "text",
      "mimeType": "application/x-yaml",
      "text": "<YAML output string>"
    }
  ]
}
```

---

## 10. File Structure (proposed)

```
rocker-os-workflow/
  workflow/
    schemas/              # Zod schemas per agent
      common.ts
      workflowmaster.ts
      cipher.ts
      assembler.ts
      sentinel.ts
      hammer.ts
      prism.ts
      bastion.ts
    agents/               # Agent instructions (existing)
      cipher/INSTRUCTIONS.md
      assembler/INSTRUCTIONS.md
      sentinel/INSTRUCTIONS.md
      hammer/INSTRUCTIONS.md
      prism/INSTRUCTIONS.md
      bastion/INSTRUCTIONS.md
    agents-registry.yaml  # Agent definitions (existing)
    callbacks.yaml        # Default + per-agent callback definitions
  a2a/
    server.ts             # A2A agent server (existing, to update)
    client.ts             # A2A client for watcher
    validator.ts          # YAML parse + Zod validation
    spawner.ts            # Context accumulation + agent spawning
```

---

## 11. Open Items (to revisit)

1. ~~**Retry feedback format**~~ — ✅ Decided: Option C (full context: instruction + path/expected/received/fix + previous output) + escalate after 3 fails
2. **Parallel agents** — merge points, dependency graph, output merging strategy
3. **Token optimization** — accumulated context grows. Summarization strategy for long pipelines?
4. **Agent self-validation** — should agents validate their own output before submitting? (leaning: yes, as first line)
5. **Pipeline templates** — pre-defined callback sets per pipeline type (Standard, Design, Legal, Security)

---

_This spec is the reference for A2A Pipeline v2 implementation. Living document — update as decisions are made._
