import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const FileImpactSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "modify", "delete"]),
  reason: z.string(),
});

const RiskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  description: z.string(),
});

const AcceptanceCriteriaCheckSchema = z.object({
  criteria: z.string(),
  met: z.boolean(),
  notes: z.string().optional(),
});

const CipherOutputSchema = z.object({
  summary: z.string(),
  files_impacted: z.array(FileImpactSchema),
  risks: z.array(RiskSchema),
  dependencies: z.array(z.string()),
  recommendations: z.array(z.string()),
  acceptance_criteria_check: z.array(AcceptanceCriteriaCheckSchema).optional(),
});

export const CipherSchema = CommonHeaderSchema.extend({
  agent: z.literal("Cipher"),
  output: CipherOutputSchema,
});

export type CipherOutput = z.infer<typeof CipherSchema>;
