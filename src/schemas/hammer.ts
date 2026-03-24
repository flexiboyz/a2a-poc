import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const DraftFileSchema = z.object({
  path: z.string(),
  section: z.string(),
  description: z.string(),
});

const HammerOutputSchema = z.object({
  legal_analysis: z.string(),
  draft_files: z.array(DraftFileSchema),
  implementation_notes: z.array(z.string()),
  open_questions: z.array(z.string()),
  sources: z.array(z.string()),
});

export const HammerSchema = CommonHeaderSchema.extend({
  agent: z.literal("Hammer"),
  output: HammerOutputSchema,
});

export type HammerOutput = z.infer<typeof HammerSchema>;
