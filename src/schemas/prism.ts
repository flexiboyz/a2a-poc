import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const ComponentSchema = z.object({
  name: z.string(),
  description: z.string(),
  props: z.array(z.string()),
});

const UserFlowSchema = z.object({
  name: z.string(),
  steps: z.array(z.string()).min(1),
});

const PrismOutputSchema = z.object({
  summary: z.string(),
  components: z.array(ComponentSchema),
  user_flows: z.array(UserFlowSchema),
  accessibility_notes: z.array(z.string()),
});

export const PrismSchema = CommonHeaderSchema.extend({
  agent: z.literal("Prism"),
  output: PrismOutputSchema,
});

export type PrismOutput = z.infer<typeof PrismSchema>;
