/**
 * Test fixtures — valid/invalid YAML per agent schema, marker variants.
 */

// ── Valid YAML outputs per agent ──────────────────────────────────────────

export const VALID_CIPHER_YAML = `
agent: Cipher
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  summary: "Analysis of the codebase complete"
  files_impacted:
    - path: src/foo.ts
      action: modify
      reason: needs refactoring
  risks:
    - level: low
      description: minimal risk
  dependencies:
    - vitest
  recommendations:
    - add E2E tests
`.trim();

export const VALID_ASSEMBLER_YAML = `
agent: Assembler
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  summary: "Implementation complete"
  branch: feat/test-feature
  pull_request:
    number: 42
    url: https://github.com/test/repo/pull/42
  commits:
    - "feat: add new feature"
  files_changed:
    - path: src/foo.ts
      action: modified
  build_status: pass
`.trim();

export const VALID_SENTINEL_YAML = `
agent: Sentinel
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  verdict: approved
  pull_request:
    number: 42
    url: https://github.com/test/repo/pull/42
    merged: true
  summary: "All checks pass, PR approved"
  files:
    - path: src/foo.ts
      status: accepted
      comment: null
  security_flags: []
  build_status: pass
  acceptance_criteria_check:
    - criteria: "Tests pass"
      met: true
`.trim();

// ── Invalid YAML (missing required fields) ────────────────────────────────

export const INVALID_CIPHER_YAML = `
agent: Cipher
task_seq: 1
iteration: 1
status: done
out_of_scope: []
pipeline_suggestion: null
output:
  summary: "ok"
`.trim();

// ── YAML with out_of_scope items ──────────────────────────────────────────

export const CIPHER_WITH_OUT_OF_SCOPE = `
agent: Cipher
task_seq: 1
iteration: 1
status: done
out_of_scope:
  - title: "Add dark mode"
    description: "User requested dark mode support"
    priority: low
  - title: "Upgrade to React 19"
    description: "React 19 migration is out of scope"
    priority: medium
pipeline_suggestion: null
output:
  summary: "Analysis complete with out of scope items"
  files_impacted:
    - path: src/app.ts
      action: modify
      reason: refactoring needed
  risks:
    - level: low
      description: no risk
  dependencies: []
  recommendations:
    - do the thing
`.trim();

// ── Output with CHANGE_REQUEST marker ─────────────────────────────────────

export const OUTPUT_WITH_CHANGE_REQUEST =
  "Agent output here.\nCHANGE_REQUEST: Assembler needs to fix formatting in src/foo.ts";

// ── Output with PIPELINE_SUGGESTION marker ────────────────────────────────

export const PIPELINE_SUGGESTION_TEXT = [
  "action: insert_after_current",
  "agent: Prism",
  'reason: "UI changes detected, design review recommended"',
].join("\n");

export const OUTPUT_WITH_PIPELINE_SUGGESTION =
  `Agent output here.\nPIPELINE_SUGGESTION:\n${PIPELINE_SUGGESTION_TEXT}`;
