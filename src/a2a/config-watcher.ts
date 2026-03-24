import { watch, type FSWatcher } from "chokidar";
import { readFileSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";
import { resetCallbacksCache } from "./callback-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKFLOW_DIR = resolve(__dirname, "../../workflow");
const DEBOUNCE_MS = 300;
let watcher: FSWatcher | null = null;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function validateYaml(filePath: string): boolean {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = YAML.load(raw);
    if (!parsed || typeof parsed !== "object") {
      console.error(`[config-watcher] Invalid YAML: ${filePath}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[config-watcher] Parse error:`, err instanceof Error ? err.message : err);
    return false;
  }
}

function handleChange(filePath: string) {
  const file = basename(filePath);
  const existing = debounceTimers.get(file);
  if (existing) clearTimeout(existing);
  debounceTimers.set(file, setTimeout(() => {
    debounceTimers.delete(file);
    if (!validateYaml(filePath)) return;
    if (file === "callbacks.yaml") {
      resetCallbacksCache();
      console.log(`[config-watcher] Reloaded callbacks.yaml`);
    }
  }, DEBOUNCE_MS));
}

export function startConfigWatcher(): void {
  if (watcher) return;
  watcher = watch([resolve(WORKFLOW_DIR, "callbacks.yaml")], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200 },
    ignored: /(^|[/\\])\../,
  });
  watcher.on("change", handleChange);
  console.log(`[config-watcher] Watching workflow/callbacks.yaml`);
}

export async function stopConfigWatcher(): Promise<void> {
  if (!watcher) return;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  await watcher.close();
  watcher = null;
  console.log(`[config-watcher] Stopped`);
}
