import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const SecurityReviewItemSchema = z.object({
  item: z.string(),
  risk: z.enum(["none", "low", "medium", "high", "critical"]),
  recommendation: z.string(),
});

const BastionOutputSchema = z.object({
  summary: z.string(),
  services_checked: z.array(z.string()),
  security_review: z.array(SecurityReviewItemSchema),
  actions_taken: z.array(z.string()),
});

export const BastionSchema = CommonHeaderSchema.extend({
  agent: z.literal("Bastion"),
  output: BastionOutputSchema,
});

export type BastionOutput = z.infer<typeof BastionSchema>;
