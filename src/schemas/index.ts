import { z } from "zod";
import YAML from "js-yaml";
import { WorkflowMasterSchema } from "./workflowmaster.js";
import { CipherSchema } from "./cipher.js";
import { AssemblerSchema } from "./assembler.js";
import { SentinelSchema } from "./sentinel.js";
import { HammerSchema } from "./hammer.js";
import { PrismSchema } from "./prism.js";
import { BastionSchema } from "./bastion.js";

export { CommonHeaderSchema } from "./common.js";
export { WorkflowMasterSchema } from "./workflowmaster.js";
export { CipherSchema } from "./cipher.js";
export { AssemblerSchema } from "./assembler.js";
export { SentinelSchema } from "./sentinel.js";
export { HammerSchema } from "./hammer.js";
export { PrismSchema } from "./prism.js";
export { BastionSchema } from "./bastion.js";

export const agentSchemas: Record<string, z.ZodType> = {
  WorkflowMaster: WorkflowMasterSchema,
  Cipher: CipherSchema,
  Assembler: AssemblerSchema,
  Sentinel: SentinelSchema,
  Hammer: HammerSchema,
  Prism: PrismSchema,
  Bastion: BastionSchema,
};

type AgentName = keyof typeof agentSchemas;

export type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; errors: z.ZodError };

function isAgentName(name: string): name is AgentName {
  return name in agentSchemas;
}

export function validateAgentOutput(
  agentName: string,
  yamlString: string
): ValidationResult {
  if (!isAgentName(agentName)) {
    return {
      success: false,
      errors: new z.ZodError([
        {
          code: "custom",
          path: ["agent"],
          message: `Unknown agent: ${agentName}. Valid agents: ${Object.keys(agentSchemas).join(", ")}`,
        },
      ]),
    };
  }

  const schema = agentSchemas[agentName];

  let parsed: unknown;
  try {
    parsed = YAML.load(yamlString);
  } catch (e) {
    return {
      success: false,
      errors: new z.ZodError([
        {
          code: "custom",
          path: [],
          message: `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ]),
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}
