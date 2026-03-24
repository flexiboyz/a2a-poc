/**
 * Template loader — loads and resolves pipeline templates from workflow/templates.yaml (§11.5)
 *
 * Callback precedence: agent overrides (callbacks.yaml) > template overrides > defaults
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import YAML from "js-yaml";
import type { CallbackAction } from "./callback-handler.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TemplateDefinition {
  description: string;
  agents: string[];
  callback_overrides: Record<string, Record<string, CallbackAction>>;
  default_prompt: string;
}

export interface TemplatesConfig {
  templates: Record<string, TemplateDefinition>;
}

export interface TemplateListItem {
  name: string;
  description: string;
  agents: string[];
  default_prompt: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

const VALID_AGENTS = ["Cipher", "Assembler", "Sentinel", "Prism", "Bastion", "Hammer"];

function validateTemplatesConfig(config: unknown): TemplatesConfig {
  if (!config || typeof config !== "object") {
    throw new Error("templates.yaml must be a YAML object");
  }
  const c = config as Record<string, unknown>;
  if (!c.templates || typeof c.templates !== "object") {
    throw new Error("templates.yaml must have a 'templates' object");
  }

  const templates = c.templates as Record<string, unknown>;
  for (const [name, def] of Object.entries(templates)) {
    if (!def || typeof def !== "object") {
      throw new Error(`Template '${name}' must be an object`);
    }
    const d = def as Record<string, unknown>;

    if (typeof d.description !== "string") {
      throw new Error(`Template '${name}' must have a 'description' string`);
    }
    if (!Array.isArray(d.agents) || d.agents.length === 0) {
      throw new Error(`Template '${name}' must have a non-empty 'agents' array`);
    }
    for (const agent of d.agents) {
      if (!VALID_AGENTS.includes(agent as string)) {
        throw new Error(`Template '${name}' has unknown agent: ${agent}`);
      }
    }
    if (typeof d.default_prompt !== "string") {
      throw new Error(`Template '${name}' must have a 'default_prompt' string`);
    }
    if (d.callback_overrides !== undefined && d.callback_overrides !== null && typeof d.callback_overrides !== "object") {
      throw new Error(`Template '${name}' callback_overrides must be an object`);
    }
  }

  return config as TemplatesConfig;
}

// ── Loading ──────────────────────────────────────────────────────────────────

let _config: TemplatesConfig | null = null;

export function loadTemplates(): TemplatesConfig {
  if (_config) return _config;
  const yamlPath = resolve(__dirname, "../../workflow/templates.yaml");
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = YAML.load(raw);
  _config = validateTemplatesConfig(parsed);
  return _config;
}

/** For testing — reset cached config */
export function resetTemplatesCache(): void {
  _config = null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve a template by name. Returns null if not found.
 */
export function resolveTemplate(name: string): TemplateDefinition | null {
  const config = loadTemplates();
  return config.templates[name] ?? null;
}

/**
 * List all available templates (for GET /api/templates).
 */
export function listTemplates(): TemplateListItem[] {
  const config = loadTemplates();
  return Object.entries(config.templates).map(([name, def]) => ({
    name,
    description: def.description,
    agents: def.agents,
    default_prompt: def.default_prompt,
  }));
}

/**
 * Get template callback overrides for a specific agent+event.
 * Returns undefined if no template override exists.
 */
export function getTemplateOverride(
  templateName: string,
  agentName: string,
  event: string,
): CallbackAction | undefined {
  const template = resolveTemplate(templateName);
  if (!template) return undefined;
  return template.callback_overrides?.[agentName]?.[event];
}
