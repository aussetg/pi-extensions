import type { AgentExecutorDescriptor, AgentProfileSnapshot, AgentToolDescriptor } from "./executor.js";

/**
 * The complete model-visible agent tool vocabulary. Profiles may narrow this
 * vocabulary, but neither profiles nor workflow source may add to it.
 */
export const FIXED_AGENT_TOOL_SETS = Object.freeze({
  inspection: Object.freeze(["read", "grep", "find", "ls"]),
  candidateEditing: Object.freeze(["edit", "write", "delete_file"]),
  mediatedResearch: Object.freeze(["web_search", "web_fetch"]),
  workspaceCommands: Object.freeze(["workspace_command"]),
});

export type FixedAgentToolName =
  (typeof FIXED_AGENT_TOOL_SETS)[keyof typeof FIXED_AGENT_TOOL_SETS][number];

export interface AgentToolAuthority {
  workspace: "snapshot" | "candidate";
  network: "none" | "research";
}

const FIXED_TOOL_NAMES = new Set<string>(Object.values(FIXED_AGENT_TOOL_SETS).flat());
const MUTATING_TOOLS = new Set<string>([
  ...FIXED_AGENT_TOOL_SETS.candidateEditing,
  ...FIXED_AGENT_TOOL_SETS.workspaceCommands,
]);
const NETWORK_TOOLS = new Set<string>(FIXED_AGENT_TOOL_SETS.mediatedResearch);

export function isFixedAgentTool(value: string): value is FixedAgentToolName {
  return FIXED_TOOL_NAMES.has(value);
}

/** Host authority for one launch. Candidate mutation and mediated research are independent. */
export function fixedToolsForAuthority(authority: AgentToolAuthority): FixedAgentToolName[] {
  return [
    ...FIXED_AGENT_TOOL_SETS.inspection,
    ...(authority.workspace === "candidate"
      ? [...FIXED_AGENT_TOOL_SETS.candidateEditing, ...FIXED_AGENT_TOOL_SETS.workspaceCommands]
      : []),
    ...(authority.network === "research" ? FIXED_AGENT_TOOL_SETS.mediatedResearch : []),
  ];
}

/**
 * Intersect a semantic profile's maximum policy with one launch's host
 * authority and the executor's exact schema catalog.
 */
export function resolveAgentTools(
  profile: AgentProfileSnapshot,
  authority: AgentToolAuthority,
  executor: AgentExecutorDescriptor,
): AgentToolDescriptor[] {
  if (authority.workspace === "candidate" && !executor.capabilities.candidateWorkspace) {
    throw new Error(`Executor ${executor.id} does not support candidate workspaces`);
  }
  if (authority.network === "research" && !executor.capabilities.mediatedNetwork) {
    throw new Error(`Executor ${executor.id} does not support mediated research`);
  }

  const permitted = new Set(fixedToolsForAuthority(authority));
  const catalog = new Map(executor.toolCatalog.map((tool) => [tool.name, tool]));
  const result: AgentToolDescriptor[] = [];
  for (const name of profile.allowedTools) {
    if (!isFixedAgentTool(name)) throw new Error(`Agent profile ${profile.id} names unknown fixed tool ${name}`);
    if (!permitted.has(name)) continue;
    const tool = catalog.get(name);
    if (!tool) throw new Error(`Executor ${executor.id} does not provide tool ${name} required by ${profile.id}`);
    const expectedMutation = MUTATING_TOOLS.has(name);
    const expectedNetwork = NETWORK_TOOLS.has(name);
    if (tool.mutatesWorkspace !== expectedMutation || tool.usesMediatedNetwork !== expectedNetwork) {
      throw new Error(`Executor ${executor.id} reports incorrect authority for fixed tool ${name}`);
    }
    result.push(structuredClone(tool));
  }
  return result;
}

