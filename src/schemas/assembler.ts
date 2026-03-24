import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const FileChangedSchema = z.object({
  path: z.string(),
  action: z.enum(["created", "modified", "deleted"]),
});

const PullRequestSchema = z.object({
  number: z.number().int(),
  url: z.string().url(),
});

const AssemblerOutputSchema = z.object({
  summary: z.string(),
  branch: z.string(),
  pull_request: PullRequestSchema,
  commits: z.array(z.string()).min(1),
  files_changed: z.array(FileChangedSchema).min(1),
  build_status: z.enum(["pass", "fail"]),
  lint_status: z.enum(["pass", "fail"]).optional(),
});

export const AssemblerSchema = CommonHeaderSchema.extend({
  agent: z.literal("Assembler"),
  output: AssemblerOutputSchema,
});

export type AssemblerOutput = z.infer<typeof AssemblerSchema>;
