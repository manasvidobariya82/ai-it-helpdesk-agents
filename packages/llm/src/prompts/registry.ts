/**
 * Prompt registry.
 *
 * Prompts are versioned and looked up by name, and the version is written to
 * the event log with every call. Without that you cannot tell a drop in
 * triage accuracy caused by a prompt edit from one caused by a model change
 * or a shift in the ticket mix.
 *
 * The system half of a prompt must stay byte-stable across calls so it caches;
 * anything that varies per ticket belongs in the user half.
 */
export interface PromptTemplate {
  name: string;
  version: string;
  /** Stable prefix. No timestamps, no ids, no per-ticket text. */
  system: (vars: Record<string, string>) => string;
  user: (vars: Record<string, string>) => string;
}

const registry = new Map<string, PromptTemplate>();

export function registerPrompt(t: PromptTemplate): PromptTemplate {
  const key = `${t.name}@${t.version}`;
  if (registry.has(key)) throw new Error(`Duplicate prompt registration: ${key}`);
  registry.set(key, t);
  registry.set(t.name, t); // latest registration wins as the default
  return t;
}

export function getPrompt(name: string, version?: string): PromptTemplate {
  const t = registry.get(version ? `${name}@${version}` : name);
  if (!t) throw new Error(`Unknown prompt: ${name}${version ? `@${version}` : ""}`);
  return t;
}

/** Minimal mustache-style fill. Unknown keys render as an empty string. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? vars[key]! : "",
  );
}
