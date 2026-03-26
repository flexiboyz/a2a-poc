/**
 * JSON Schema versions of agent output schemas for OpenRouter structured outputs.
 * These are passed to response_format.json_schema.schema in API calls.
 */

const commonProperties = {
  agent: { type: "string" },
  task_seq: { type: "integer" },
  iteration: { type: "integer" },
  status: { type: "string", enum: ["done", "fail", "waiting_user"] },
  waiting_reason: { type: "string", description: "Reason for waiting_user status, or empty string if not applicable" },
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
    type: "object",
    description: "Optional pipeline suggestion. Set has_suggestion=false when no suggestion, true with action/agent/reason when suggesting.",
    properties: {
      has_suggestion: { type: "boolean" },
      action: { type: "string", enum: ["insert_after_current", "insert_before_next", "replace_next"] },
      agent: { type: "string" },
      reason: { type: "string" },
    },
    required: ["has_suggestion"],
    additionalProperties: false,
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

/**
 * Assembler Phase 1 schema — code generation output.
 * This is NOT the final YAML output (which is constructed by the executor).
 * The LLM produces structured JSON with file contents, branch name, and commits.
 */
export const AssemblerCodeGenJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Brief summary of what was implemented" },
    branch: { type: "string", description: "Branch name (e.g. feat/add-legal-pages)" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path from workspace root" },
          action: { type: "string", enum: ["create", "modify", "delete"] },
          content: { type: "string", description: "Complete file content (empty string for delete)" },
        },
        required: ["path", "action", "content"],
        additionalProperties: false,
      },
      minItems: 1,
    },
    commits: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Conventional commit messages",
    },
  },
  required: ["summary", "branch", "files", "commits"],
  additionalProperties: false,
};

/**
 * Sentinel review schema — LLM produces a review verdict with per-file comments.
 */
export const SentinelReviewJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "request_changes"] },
    summary: { type: "string", description: "Overall review summary" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          status: { type: "string", enum: ["accepted", "rejected", "needs_changes"] },
          comment: { type: "string", description: "Review comment explaining the status" },
        },
        required: ["path", "status", "comment"],
        additionalProperties: false,
      },
    },
    security_flags: {
      type: "array",
      items: { type: "string" },
      description: "Specific security concerns found",
    },
    acceptance_criteria_check: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criteria: { type: "string" },
          met: { type: "boolean" },
        },
        required: ["criteria", "met"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "files", "security_flags", "acceptance_criteria_check"],
  additionalProperties: false,
};

/**
 * Bastion security review schema.
 */
export const BastionReviewJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Overall security assessment summary" },
    services_checked: {
      type: "array",
      items: { type: "string" },
      description: "List of services/components audited",
    },
    security_review: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "What was checked or found" },
          risk: { type: "string", enum: ["none", "low", "medium", "high", "critical"] },
          recommendation: { type: "string", description: "Specific actionable fix" },
        },
        required: ["item", "risk", "recommendation"],
        additionalProperties: false,
      },
    },
    actions_taken: {
      type: "array",
      items: { type: "string" },
      description: "Actions performed during the audit",
    },
  },
  required: ["summary", "services_checked", "security_review", "actions_taken"],
  additionalProperties: false,
};

/**
 * Prism UX design schema — includes mockup descriptions for image generation.
 */
export const PrismDesignJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Design approach summary" },
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          props: { type: "array", items: { type: "string" } },
          visual_spec: { type: "string", description: "Detailed visual specification (colors, sizes, spacing)" },
          states: { type: "array", items: { type: "string" }, description: "Interactive states (hover, active, disabled, loading, error)" },
        },
        required: ["name", "description", "props"],
        additionalProperties: false,
      },
    },
    user_flows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          steps: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["name", "steps"],
        additionalProperties: false,
      },
    },
    mockup_descriptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Screen/view name" },
          viewport: { type: "string", enum: ["mobile", "desktop", "both"], description: "Target viewport" },
          prompt: { type: "string", description: "Detailed image-gen prompt describing exactly what the screen looks like" },
        },
        required: ["name", "viewport", "prompt"],
        additionalProperties: false,
      },
      description: "Image-generation-ready mockup descriptions",
    },
    accessibility_notes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "components", "user_flows", "mockup_descriptions", "accessibility_notes"],
  additionalProperties: false,
};
