import { z } from "zod";

export const StatusSchema = z.enum(["done", "fail", "waiting_user"]);

export const PipelineSuggestionSchema = z
  .object({
    action: z.enum(["insert_after_current", "insert_before_next", "replace_next"]),
    agent: z.string(),
    reason: z.string(),
  })
  .nullable()
  .optional();

export const OutOfScopeItemSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.string().optional(),
});

export const CommonHeaderSchema = z.object({
  agent: z.string(),
  task_seq: z.number().int(),
  iteration: z.number().int().positive(),
  status: StatusSchema,
  waiting_reason: z.string().nullable().optional(),
  out_of_scope: z.array(OutOfScopeItemSchema).default([]),
  pipeline_suggestion: PipelineSuggestionSchema,
});

export type CommonHeader = z.infer<typeof CommonHeaderSchema>;
