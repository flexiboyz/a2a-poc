# Structured Outputs — Multi-Provider Guide for A2A Pipeline

_Last updated: 2026-03-25_

This document covers everything we've learned about structured outputs across providers (Anthropic, Google, OpenAI) via OpenRouter, and how to write schemas that work universally.

---

## Table of Contents

1. [Overview](#overview)
2. [How It Works via OpenRouter](#how-it-works-via-openrouter)
3. [Provider Comparison](#provider-comparison)
4. [Anthropic (Claude) — Specifics & Limitations](#anthropic-claude--specifics--limitations)
5. [Google (Gemini) — Specifics](#google-gemini--specifics)
6. [OpenAI (GPT) — Specifics](#openai-gpt--specifics)
7. [Universal Schema Rules](#universal-schema-rules)
8. [Our A2A Pipeline Schemas](#our-a2a-pipeline-schemas)
9. [Common Errors & Fixes](#common-errors--fixes)
10. [Cost Comparison](#cost-comparison)
11. [SDK Integration Patterns](#sdk-integration-patterns)
12. [References](#references)

---

## Overview

Structured outputs constrain an LLM's response to follow a specific JSON schema, guaranteeing valid, parseable output. This eliminates:
- `JSON.parse()` errors from malformed output
- Missing required fields
- Inconsistent data types
- The need for retry loops on schema violations

### Two Approaches

| Approach | When to use |
|----------|-------------|
| **OpenRouter `response_format`** | Via API (our gateway uses this). OpenRouter translates to native format per provider. |
| **Native API** | Direct SDK calls (Anthropic: `output_config.format`, OpenAI: `response_format`) |

We use **OpenRouter** as our gateway, so we always send the OpenAI-compatible `response_format` format, and OpenRouter handles translation.

---

## How It Works via OpenRouter

### Request Format

```typescript
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
  },
  body: JSON.stringify({
    model: "anthropic/claude-sonnet-4.6",  // or google/gemini-2.5-pro, etc.
    messages: [{ role: "user", content: taskPrompt }],
    max_tokens: 8192,
    temperature: 0.3,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "AgentName_output",
        strict: true,
        schema: {
          type: "object",
          properties: { ... },
          required: [...],
          additionalProperties: false
        }
      }
    }
  })
});
```

### Response Format

The model's response is a JSON string in `choices[0].message.content`. Parse it directly:

```typescript
const data = await response.json();
const output = JSON.parse(data.choices[0].message.content);
// output is guaranteed to match your schema
```

### What OpenRouter Does Under the Hood

| Provider | OpenRouter translates `response_format` to... |
|----------|-----------------------------------------------|
| **Anthropic** | `output_config.format` with `type: "json_schema"` |
| **Google** | Native Gemini structured output format |
| **OpenAI** | Passed through as-is (native format) |

This means **you write one schema format** and it works across all providers — with caveats (see limitations below).

---

## Provider Comparison

| Feature | Anthropic (Claude) | Google (Gemini) | OpenAI (GPT) |
|---------|-------------------|-----------------|---------------|
| **Structured outputs** | ✅ Opus 4.6, Sonnet 4.6/4.5, Opus 4.5, Haiku 4.5 | ✅ All Gemini models | ✅ GPT-4o+ |
| **`type: "object"`** | ✅ | ✅ | ✅ |
| **`type: "array"`** | ✅ | ✅ | ✅ |
| **`type: "string"` with `enum`** | ✅ | ✅ | ✅ |
| **`additionalProperties: false`** | ✅ Required | ✅ | ✅ Required in strict |
| **`oneOf`** | ❌ **NOT SUPPORTED** | ✅ | ✅ |
| **`anyOf`** | ❌ **NOT SUPPORTED** | ✅ | ✅ |
| **`allOf`** | ❌ **NOT SUPPORTED** | ✅ | ✅ |
| **`type: ["string", "null"]`** (type arrays) | ❌ **NOT SUPPORTED** | ✅ | ✅ |
| **`$ref` / `$defs`** | ❌ No `$ref` support | ✅ | ✅ |
| **Nested objects** | ✅ | ✅ | ✅ |
| **Arrays of objects** | ✅ | ✅ | ✅ |
| **`description` on properties** | ✅ | ✅ | ✅ |
| **`minItems` / `maxItems`** | ❌ Removed by SDK transform | ✅ | ✅ |
| **`minimum` / `maximum`** | ❌ Removed by SDK transform | ✅ | ✅ |
| **`pattern`** | ❌ | ✅ | ✅ |
| **Streaming** | ✅ | ✅ | ✅ |
| **Max schema depth** | ~4 levels recommended | No hard limit | No hard limit |
| **ZDR (Zero Data Retention)** | ✅ Schema cached 24h | N/A | N/A |

---

## Anthropic (Claude) — Specifics & Limitations

### ❌ Unsupported Schema Features

These will return `400 invalid_request_error`:

```
output_config.format.schema: Schema type 'oneOf' is not supported
output_config.format.schema: Schema type 'anyOf' is not supported  
output_config.format.schema: Schema type 'allOf' is not supported
```

#### 1. `oneOf` — NOT SUPPORTED

**❌ Will fail:**
```json
{
  "pipeline_suggestion": {
    "oneOf": [
      { "type": "null" },
      {
        "type": "object",
        "properties": { "action": { "type": "string" } },
        "required": ["action"]
      }
    ]
  }
}
```

**✅ Workaround — flat object with boolean flag:**
```json
{
  "pipeline_suggestion": {
    "type": "object",
    "properties": {
      "has_suggestion": { "type": "boolean" },
      "action": { "type": "string", "enum": ["insert_after_current", "insert_before_next", "replace_next"] },
      "agent": { "type": "string" },
      "reason": { "type": "string" }
    },
    "required": ["has_suggestion"],
    "additionalProperties": false
  }
}
```

#### 2. Type Arrays — NOT SUPPORTED

**❌ Will fail:**
```json
{ "waiting_reason": { "type": ["string", "null"] } }
```

**✅ Workaround — use string with description:**
```json
{ "waiting_reason": { "type": "string", "description": "Reason for waiting, or empty string if not applicable" } }
```

#### 3. `$ref` / `$defs` — NOT SUPPORTED

Don't use JSON Schema references. Inline everything.

### ✅ What Works

- Nested objects (any depth, though keep it reasonable)
- Arrays of objects with typed items
- `enum` on string fields
- `description` on any property
- `additionalProperties: false` (required on all objects)
- `required` arrays
- `integer` and `number` types
- `boolean` type

### API Parameter Names

| Via OpenRouter | Native Anthropic API |
|----------------|---------------------|
| `response_format.json_schema.schema` | `output_config.format.schema` |
| `response_format.type = "json_schema"` | `output_config.format.type = "json_schema"` |

OpenRouter handles the translation. You never need to use the native format.

### Supported Models

- Claude Opus 4.6 (`anthropic/claude-opus-4.6`)
- Claude Sonnet 4.6 (`anthropic/claude-sonnet-4.6`)
- Claude Sonnet 4.5 (`anthropic/claude-sonnet-4.5`)
- Claude Opus 4.5 (`anthropic/claude-opus-4.5`)
- Claude Haiku 4.5 (`anthropic/claude-haiku-4.5`)

Older models (Claude 3.x) do NOT support structured outputs.

---

## Google (Gemini) — Specifics

### Supported Features

Gemini supports the full JSON Schema spec including `oneOf`, `anyOf`, type arrays, and `$ref`. No special workarounds needed.

### Models

- `google/gemini-2.5-pro`
- `google/gemini-2.5-flash`
- All Gemini 1.5+ models

### Notes

- Gemini Pro was observed to be "lazy" on optional fields — sometimes omits them entirely
- Adding `description` to optional fields helps guide Gemini to fill them
- Prompt engineering matters more with Gemini for schema compliance

---

## OpenAI (GPT) — Specifics

### Supported Features

Full JSON Schema support in strict mode. The `response_format` parameter is native to OpenAI.

### Models

- GPT-4o and later
- o1 and later

---

## Universal Schema Rules

To write schemas that work across **all** providers (Anthropic + Gemini + OpenAI), follow these rules:

### DO ✅

```typescript
// 1. Always use additionalProperties: false on every object
{ type: "object", properties: {...}, required: [...], additionalProperties: false }

// 2. Use simple types (string, number, integer, boolean, object, array)
{ type: "string" }
{ type: "integer" }
{ type: "boolean" }

// 3. Use enum for constrained strings
{ type: "string", enum: ["low", "medium", "high"] }

// 4. Use arrays with typed items
{ type: "array", items: { type: "object", properties: {...}, required: [...], additionalProperties: false } }

// 5. Add descriptions — they improve quality across all providers
{ type: "string", description: "The file path relative to project root" }

// 6. Put all properties in required (Anthropic requires this)
required: ["field1", "field2", "field3"]  // ALL fields must be required
```

### DON'T ❌

```typescript
// 1. No oneOf / anyOf / allOf
❌ { oneOf: [{ type: "null" }, { type: "object", ... }] }

// 2. No type arrays
❌ { type: ["string", "null"] }

// 3. No $ref / $defs
❌ { "$ref": "#/$defs/MyType" }

// 4. No optional properties (make everything required, use empty string / false as "absent")
❌ required: ["field1"]  // with field2 and field3 optional

// 5. No minItems / maxItems / minimum / maximum / pattern (Anthropic strips them)
❌ { type: "array", minItems: 1, maxItems: 10 }
```

### Nullable Pattern (Universal)

Instead of `oneOf: [null, object]` or `type: ["string", "null"]`:

```typescript
// Option A: Boolean flag pattern
{
  type: "object",
  properties: {
    has_value: { type: "boolean" },
    data: { type: "string" }
  },
  required: ["has_value", "data"],
  additionalProperties: false
}

// Option B: Empty string / empty object as sentinel
{
  type: "string",
  description: "Value or empty string if not applicable"
}
```

---

## Our A2A Pipeline Schemas

### Common Header (all agents)

```typescript
{
  agent: { type: "string" },                    // Agent name
  task_seq: { type: "integer" },                // Task sequence number
  iteration: { type: "integer" },               // Iteration count (for retry loops)
  status: { type: "string", enum: ["done", "fail", "waiting_user"] },
  waiting_reason: { type: "string" },           // Empty string if N/A
  out_of_scope: {                               // Items found but outside task scope
    type: "array",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" }
      },
      required: ["title", "description"],
      additionalProperties: false
    }
  },
  pipeline_suggestion: {                        // Suggest pipeline changes
    type: "object",
    properties: {
      has_suggestion: { type: "boolean" },
      action: { type: "string", enum: ["insert_after_current", "insert_before_next", "replace_next"] },
      agent: { type: "string" },
      reason: { type: "string" }
    },
    required: ["has_suggestion"],
    additionalProperties: false
  }
}
```

### Cipher Output

```typescript
output: {
  summary: { type: "string" },
  files_impacted: [{
    path: string,
    action: "create" | "modify" | "delete",
    reason: string
  }],
  risks: [{
    level: "low" | "medium" | "high",
    description: string
  }],
  dependencies: string[],
  recommendations: string[],
  acceptance_criteria_check: [{       // Optional in Gemini, required for Claude
    criteria: string,
    met: boolean,
    notes: string
  }]
}
```

### WorkflowMaster Output

```typescript
output: {
  qualification: {
    complexity: "low" | "medium" | "high",
    type: "code" | "design" | "legal" | "mixed",
    estimated_agents: integer
  },
  pipeline: string[],                 // Ordered list of agent names
  branch: string,                     // Git branch name
  acceptance_criteria: string[],      // Min 1 item
  context_notes: string               // Free-form context
}
```

### Schema Files

- **JSON Schemas** (for OpenRouter `response_format`): `src/schemas/json-schemas.ts`
- **Zod Schemas** (for runtime validation): `src/schemas/*.ts` (common, cipher, workflowmaster, assembler, sentinel, hammer, prism)

---

## Common Errors & Fixes

### Error: `Schema type 'oneOf' is not supported`

**Provider:** Anthropic  
**Cause:** Using `oneOf`, `anyOf`, or `allOf` in schema  
**Fix:** Replace with flat object + boolean flag pattern (see [Nullable Pattern](#nullable-pattern-universal))

### Error: `Schema type 'array' is not supported` (on type field)

**Provider:** Anthropic  
**Cause:** Using `type: ["string", "null"]`  
**Fix:** Use `type: "string"` with description explaining empty string = null

### Error: `anthropic/claude-sonnet-4-20250514 is not a valid model ID`

**Provider:** OpenRouter  
**Cause:** Using Anthropic's native model ID format instead of OpenRouter's  
**Fix:** Use OpenRouter model IDs: `anthropic/claude-sonnet-4.6` (dots, not dashes)

### Error: 400 with no structured output

**Provider:** Any  
**Cause:** Model doesn't support structured outputs  
**Fix:** Check OpenRouter model page for `supported_parameters: structured_outputs`

### Error: Response is valid JSON but schema violations

**Provider:** Gemini (mainly)  
**Cause:** Gemini sometimes skips optional fields or returns wrong enum values  
**Fix:** Add `description` to all fields, make all fields `required`, add prompt reinforcement

---

## Cost Comparison

Pricing per 1M tokens (as of 2026-03):

| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| `google/gemini-2.5-flash` | $0.15 | $0.60 | Cheapest, good for SM/routing |
| `google/gemini-2.5-pro` | $1.25 | $10.00 | Good quality/cost ratio |
| `anthropic/claude-sonnet-4.6` | $3.00 | $15.00 | Best code quality at mid-range |
| `anthropic/claude-opus-4.6` | $15.00 | $75.00 | Best overall, 15x more than Gemini Pro |

### Our Current Agent Config

```bash
# .env
MODEL_WORKFLOWMASTER=google/gemini-2.5-flash     # Fast qualification, cheap
MODEL_CIPHER=anthropic/claude-sonnet-4.6          # Best analysis quality
MODEL_ASSEMBLER=google/gemini-2.5-pro             # Good code generation
MODEL_SENTINEL=google/gemini-2.5-pro              # Good review quality
MODEL_HAMMER=google/gemini-2.5-flash              # Legal drafting (less code-critical)
MODEL_PRISM=google/gemini-2.5-flash               # UI design (less code-critical)
```

---

## SDK Integration Patterns

### TypeScript (our stack)

#### With Zod (recommended for type safety)

```typescript
import { z } from "zod";

const CipherOutput = z.object({
  agent: z.string(),
  task_seq: z.number().int(),
  iteration: z.number().int(),
  status: z.enum(["done", "fail", "waiting_user"]),
  output: z.object({
    summary: z.string(),
    files_impacted: z.array(z.object({
      path: z.string(),
      action: z.enum(["create", "modify", "delete"]),
      reason: z.string(),
    })),
    // ...
  }),
});

type CipherOutputType = z.infer<typeof CipherOutput>;
```

#### Converting Zod → JSON Schema (Anthropic-safe)

⚠️ `zod-to-json-schema` generates `oneOf` for nullable types. You must manually write JSON schemas for Anthropic compatibility, or post-process the output.

```typescript
// DON'T: z.string().nullable() → generates oneOf: [string, null] → Anthropic rejects
// DO: Write JSON schema manually in json-schemas.ts
```

### Python (for reference)

```python
from pydantic import BaseModel

class CipherOutput(BaseModel):
    agent: str
    task_seq: int
    status: str  # "done" | "fail" | "waiting_user"
    output: dict

# Anthropic SDK
response = client.messages.parse(
    model="claude-opus-4-6",
    output_format=CipherOutput,
    messages=[...],
)
```

---

## References

- [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Google Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [OpenRouter Models (filter by structured output support)](https://openrouter.ai/models?order=newest&supported_parameters=structured_outputs)

---

## Changelog

- **2026-03-25:** Initial version. Documented Anthropic `oneOf`/`anyOf` limitation discovered during A2A POC testing. Fixed gateway exclusion of Anthropic models. Tested Claude Sonnet 4.6 structured output via OpenRouter — works with Anthropic-compatible schemas.
