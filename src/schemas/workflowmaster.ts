import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const WorkflowMasterOutputSchema = z.object({
  qualification: z.object({
    complexity: z.enum(["low", "medium", "high"]),
    type: z.enum(["code", "design", "legal", "mixed"]),
    estimated_agents: z.number().int().positive(),
  }),
  pipeline: z.array(z.string()).min(1),
  branch: z.string(),
  acceptance_criteria: z.array(z.string()).min(1),
  context_notes: z.string().optional(),
});

export const WorkflowMasterSchema = CommonHeaderSchema.extend({
  agent: z.literal("WorkflowMaster"),
  output: WorkflowMasterOutputSchema,
});

export type WorkflowMasterOutput = z.infer<typeof WorkflowMasterSchema>;
