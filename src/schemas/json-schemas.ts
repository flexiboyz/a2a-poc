/**
 * JSON Schema versions of agent output schemas for OpenRouter structured outputs.
 * These are passed to response_format.json_schema.schema in API calls.
 */

const commonProperties = {
  agent: { type: "string" },
  task_seq: { type: "integer" },
  iteration: { type: "integer" },
  status: { type: "string", enum: ["done", "fail", "waiting_user"] },
  waiting_reason: { type: ["string", "null"] },
  out_of_scope: {
    type: "array",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
  },
  pipeline_suggestion: {
    oneOf: [
      { type: "null" },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["insert_after_current", "insert_before_next", "replace_next"] },
          agent: { type: "string" },
          reason: { type: "string" },
        },
        required: ["action", "agent", "reason"],
        additionalProperties: false,
      },
    ],
  },
};

const commonRequired = ["agent", "task_seq", "iteration", "status", "out_of_scope", "output"];

export const WorkflowMasterJsonSchema = {
  type: "object",
  properties: {
    ...commonProperties,
    output: {
      type: "object",
      properties: {
        qualification: {
          type: "object",
          properties: {
            complexity: { type: "string", enum: ["low", "medium", "high"] },
            type: { type: "string", enum: ["code", "design", "legal", "mixed"] },
            estimated_agents: { type: "integer" },
          },
          required: ["complexity", "type", "estimated_agents"],
          additionalProperties: false,
        },
        pipeline: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        branch: { type: "string" },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        context_notes: { type: "string" },
      },
      required: ["qualification", "pipeline", "branch", "acceptance_criteria"],
      additionalProperties: false,
    },
  },
  required: commonRequired,
  additionalProperties: false,
};

export const CipherJsonSchema = {
  type: "object",
  properties: {
    ...commonProperties,
    output: {
      type: "object",
      properties: {
        summary: { type: "string" },
        files_impacted: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              action: { type: "string", enum: ["create", "modify", "delete"] },
              reason: { type: "string" },
            },
            required: ["path", "action", "reason"],
            additionalProperties: false,
          },
        },
        risks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              level: { type: "string", enum: ["low", "medium", "high"] },
              description: { type: "string" },
            },
            required: ["level", "description"],
            additionalProperties: false,
          },
        },
        dependencies: { type: "array", items: { type: "string" } },
        recommendations: { type: "array", items: { type: "string" } },
        acceptance_criteria_check: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criteria: { type: "string" },
              met: { type: "boolean" },
              notes: { type: "string" },
            },
            required: ["criteria", "met"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "files_impacted", "risks", "dependencies", "recommendations"],
      additionalProperties: false,
    },
  },
  required: commonRequired,
  additionalProperties: false,
};
