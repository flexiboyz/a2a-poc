import { z } from "zod";
import { CommonHeaderSchema } from "./common.js";

const FileReviewSchema = z.object({
  path: z.string(),
  status: z.enum(["accepted", "rejected", "needs_changes"]),
  comment: z.string().nullable(),
});

const AcceptanceCriteriaCheckSchema = z.object({
  criteria: z.string(),
  met: z.boolean(),
});

const PullRequestSchema = z.object({
  number: z.number().int(),
  url: z.string().url(),
  merged: z.boolean(),
});

const SentinelOutputSchema = z.object({
  verdict: z.enum(["approved", "request_changes"]),
  pull_request: PullRequestSchema,
  summary: z.string(),
  files: z.array(FileReviewSchema),
  security_flags: z.array(z.string()),
  build_status: z.enum(["pass", "fail"]),
  acceptance_criteria_check: z.array(AcceptanceCriteriaCheckSchema),
});

export const SentinelSchema = CommonHeaderSchema.extend({
  agent: z.literal("Sentinel"),
  output: SentinelOutputSchema,
});

export type SentinelOutput = z.infer<typeof SentinelSchema>;
