import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFINITION_LIMITS, FLOW_NAME_PATTERN } from "../definition/limits.js";
import { getAgentDir, projectRoot } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { stableHash } from "../utils/hashes.js";
import type { AgentProfileSnapshot } from "./executor.js";
import { FIXED_AGENT_TOOL_SETS, isFixedAgentTool } from "./tool-policy.js";

export type AgentProfileNamespace = "builtin" | "user" | "project";

export interface AgentProfileDefinition {
  name: string;
  title?: string;
  description: string;
  instructions: string;
  /** Maximum semantic tool policy. Launch authority may narrow it further. */
  tools?: string[];
}

export interface AgentProfileRef extends AgentProfileDefinition {
  id: `${AgentProfileNamespace}:${string}`;
  namespace: AgentProfileNamespace;
  path: string;
  hash: string;
}

export interface InvalidAgentProfileRef {
  namespace: AgentProfileNamespace;
  path: string;
  name: string;
  error: string;
}

export interface AgentProfileRegistryRefreshOptions {
  /** Enable only after project trust. Defaults to false. */
  includeProject?: boolean;
  userDir?: string;
  projectDir?: string;
  builtins?: readonly AgentProfileDefinition[];
}

const PROFILE_FIELDS = new Set(["name", "title", "description", "tools"]);
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const BUILTIN_AGENT_PROFILES: readonly AgentProfileDefinition[] = Object.freeze([
  Object.freeze({
    name: "base",
    description: "Small read-only workflow agent",
    instructions: "Complete the bounded task from the supplied project view and inputs. Distinguish observed facts from inference.",
  }),
  Object.freeze({
    name: "researcher",
    description: "Source-grounded read-only research",
    instructions: "Gather primary evidence, cite concrete URLs or project paths, distinguish observation from inference, and return the requested contract.",
    tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"],
  }),
  Object.freeze({
    name: "synthesizer",
    description: "Evidence-preserving synthesis",
    instructions: "Synthesize only the supplied evidence. Preserve uncertainty and do not invent support for unavailable claims.",
    tools: ["read"],
  }),
  Object.freeze({
    name: "reviewer",
    description: "Adversarial read-only reviewer",
    instructions: "Inspect the exact supplied project state and evidence. Look for omissions, contradictions, unsafe assumptions, and missing tests.",
    tools: ["read", "grep", "find", "ls"],
  }),
  Object.freeze({
    name: "implementer",
    description: "Bounded candidate implementer",
    instructions: "Implement one coherent requested change inside the assigned disposable candidate workspace and report exactly what changed. Use workspace_command with an argv array for tests, moves, or mode changes; it has no shell or network. Use mediated research only when the launch grants it.",
    tools: [
      "read", "grep", "find", "ls", "edit", "write", "delete_file", "workspace_command",
      "web_search", "web_fetch",
    ],
  }),
]);

export class AgentProfileRegistry {
  private refs = new Map<string, AgentProfileRef>();
  private invalid: InvalidAgentProfileRef[] = [];

  async refresh(cwd: string, options: AgentProfileRegistryRefreshOptions = {}): Promise<void> {
    const refs = new Map<string, AgentProfileRef>();
    const invalid: InvalidAgentProfileRef[] = [];
    const builtinEntries = (options.builtins ?? BUILTIN_AGENT_PROFILES).map((definition) => {
      try {
        return { ref: profileRef("builtin", `<builtin:${definition.name}>`, definition) };
      } catch (error) {
        return { error: invalidRef("builtin", `<builtin:${String(definition.name)}>`, String(definition.name), error) };
      }
    });
    addNamespaceEntries("builtin", builtinEntries, refs, invalid);

    const roots: Array<{ namespace: "user" | "project"; dir: string }> = [
      { namespace: "user", dir: options.userDir ?? path.join(getAgentDir(), "agents") },
    ];
    if (options.includeProject === true) {
      roots.push({ namespace: "project", dir: options.projectDir ?? path.join(projectRoot(cwd), ".pi", "agents") });
    }
    for (const root of roots) {
      const entries: Array<{ ref?: AgentProfileRef; error?: InvalidAgentProfileRef }> = [];
      let files: string[];
      try { files = await listMarkdownFiles(root.dir); }
      catch (error) {
        invalid.push(invalidRef(root.namespace, root.dir, "<registry>", error));
        continue;
      }
      for (const filePath of files) {
        try {
          const stat = await fs.promises.lstat(filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent profile must be a regular non-symlink file");
          const text = await readBoundedTextFile(filePath, DEFINITION_LIMITS.profileBytes);
          entries.push({ ref: profileRef(root.namespace, filePath, parseAgentProfile(text, filePath)) });
        } catch (error) {
          entries.push({ error: invalidRef(root.namespace, filePath, path.basename(filePath, ".md"), error) });
        }
      }
      addNamespaceEntries(root.namespace, entries, refs, invalid);
    }
    this.refs = refs;
    this.invalid = invalid;
  }

  list(): AgentProfileRef[] {
    return [...this.refs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  listInvalid(): InvalidAgentProfileRef[] {
    return [...this.invalid].sort((a, b) => a.path.localeCompare(b.path));
  }

  get(id: string): AgentProfileRef | undefined {
    return this.refs.get(id);
  }

  resolve(selector: string): AgentProfileRef {
    if (selector.includes(":")) {
      if (!/^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/.test(selector)) {
        throw new Error(`Invalid agent profile selector ${selector}`);
      }
      const exact = this.refs.get(selector);
      if (!exact) throw new Error(`Unknown agent profile ${selector}`);
      return exact;
    }
    if (!FLOW_NAME_PATTERN.test(selector)) throw new Error(`Invalid agent profile selector ${selector}`);
    const matches = this.list().filter((profile) => profile.name === selector);
    if (matches.length === 0) throw new Error(`Unknown agent profile ${selector}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous agent profile ${selector}; use one of ${matches.map((profile) => profile.id).join(", ")}`);
    }
    return matches[0]!;
  }
}

export function parseAgentProfile(text: string, filePath = "<profile>"): AgentProfileDefinition {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) throw new Error("Agent profile contains disallowed control characters");
  for (const scalar of text) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error("Agent profile contains an unpaired surrogate");
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  const parsed = parseFrontmatter<Record<string, unknown>>(normalized);
  for (const key of Object.keys(parsed.frontmatter)) {
    if (!PROFILE_FIELDS.has(key)) throw new Error(`Unknown agent profile frontmatter field ${key}`);
  }
  const name = requiredString(parsed.frontmatter.name, "name", 64);
  if (!FLOW_NAME_PATTERN.test(name)) throw new Error("Agent profile name must match ^[a-z][a-z0-9_-]{0,63}$");
  if (filePath !== "<profile>" && !filePath.startsWith("<builtin:") && path.basename(filePath, ".md") !== name) {
    throw new Error(`Agent profile name ${name} must match filename ${path.basename(filePath, ".md")}`);
  }
  const description = requiredString(
    parsed.frontmatter.description,
    "description",
    DEFINITION_LIMITS.profileDescriptionScalars,
  );
  const instructions = parsed.body.trim();
  boundedScalars(instructions, "instructions", DEFINITION_LIMITS.profileInstructionsScalars);
  if (!instructions) throw new Error("Agent profile instructions body must not be empty");

  const title = optionalString(parsed.frontmatter.title, "title", 200);
  const tools = parseTools(parsed.frontmatter.tools);
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    description,
    instructions,
    ...(tools !== undefined ? { tools } : {}),
  };
}

/** Convert a registered semantic profile into the immutable run snapshot. */
export function snapshotAgentProfile(profile: AgentProfileRef): AgentProfileSnapshot {
  const allowedTools = profile.tools ?? [...FIXED_AGENT_TOOL_SETS.inspection];
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    ...(profile.title !== undefined ? { title: profile.title } : {}),
    description: profile.description,
    instructions: profile.instructions,
    allowedTools: [...allowedTools],
    hash: profile.hash,
    sourcePath: profile.path,
  });
}

function profileRef(
  namespace: AgentProfileNamespace,
  filePath: string,
  definition: AgentProfileDefinition,
): AgentProfileRef {
  const normalized = normalizeDefinition(definition);
  return {
    ...normalized,
    id: `${namespace}:${normalized.name}`,
    namespace,
    path: filePath,
    hash: stableHash({ namespace, definition: normalized }),
  };
}

function normalizeDefinition(definition: AgentProfileDefinition): AgentProfileDefinition {
  const synthetic = [
    "---",
    `name: ${JSON.stringify(definition.name)}`,
    ...(definition.title === undefined ? [] : [`title: ${JSON.stringify(definition.title)}`]),
    `description: ${JSON.stringify(definition.description)}`,
    ...(definition.tools === undefined ? [] : [`tools: [${definition.tools.map((tool) => JSON.stringify(tool)).join(", ")}]`]),
    "---",
    definition.instructions,
  ].join("\n");
  return parseAgentProfile(synthetic);
}

function addNamespaceEntries(
  namespace: AgentProfileNamespace,
  entries: Array<{ ref?: AgentProfileRef; error?: InvalidAgentProfileRef }>,
  refs: Map<string, AgentProfileRef>,
  invalid: InvalidAgentProfileRef[],
): void {
  const valid = entries.flatMap((entry) => entry.ref ? [entry.ref] : []);
  invalid.push(...entries.flatMap((entry) => entry.error ? [entry.error] : []));
  const groups = new Map<string, AgentProfileRef[]>();
  for (const ref of valid) groups.set(ref.name, [...(groups.get(ref.name) ?? []), ref]);
  for (const [name, group] of groups) {
    if (group.length > 1) {
      for (const ref of group) invalid.push(invalidRef(namespace, ref.path, name, new Error(`Duplicate ${namespace} agent profile ${name}`)));
      continue;
    }
    const ref = group[0]!;
    refs.set(ref.id, ref);
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    const stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe agent profile directory ${dir}`);
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > DEFINITION_LIMITS.profileFilesPerNamespace) {
    throw new Error(`Agent profile directory exceeds ${DEFINITION_LIMITS.profileFilesPerNamespace} entries`);
  }
  const files = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
  if (files.length > DEFINITION_LIMITS.profileFilesPerNamespace) {
    throw new Error(`Agent profile directory exceeds ${DEFINITION_LIMITS.profileFilesPerNamespace} files`);
  }
  return files;
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((part) => part.trim()).filter(Boolean)
      : undefined;
  if (!values || values.length > DEFINITION_LIMITS.profileTools) {
    throw new Error(`Agent profile tools must be an array of at most ${DEFINITION_LIMITS.profileTools} names`);
  }
  const tools: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !TOOL_NAME.test(value)) throw new Error(`Invalid agent profile tool ${String(value)}`);
    if (!isFixedAgentTool(value)) throw new Error(`Agent profile tool ${value} is not in the fixed host tool sets`);
    if (tools.includes(value)) throw new Error(`Duplicate agent profile tool ${value}`);
    tools.push(value);
  }
  return tools;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Agent profile ${label} must be a non-empty string`);
  boundedScalars(value, label, maximum);
  return value.trim();
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label, maximum);
}

function boundedScalars(value: string, label: string, maximum: number): void {
  if (Array.from(value).length > maximum) throw new Error(`Agent profile ${label} exceeds ${maximum} Unicode scalars`);
  if (/\p{Cc}/u.test(value.replace(/[\n\t]/g, ""))) throw new Error(`Agent profile ${label} contains control characters`);
}

function invalidRef(
  namespace: AgentProfileNamespace,
  filePath: string,
  name: string,
  error: unknown,
): InvalidAgentProfileRef {
  return { namespace, path: filePath, name, error: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
