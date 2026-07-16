import { stableHash } from "../utils/hashes.js";
import { buildWorkflowCallKey } from "../persistence/workflow-journal.js";
import type {
  AgentProfileSnapshot,
  AgentRouteSnapshot,
  AgentToolDescriptor,
} from "./executor.js";
import { exactRouteIdentity } from "./routes.js";

export interface AgentCallProvenance {
  profileId: string;
  profileHash: string;
  routeId: string;
  routeHash: string;
  provider: string;
  model: string;
  thinking: AgentRouteSnapshot["thinking"];
  tools: Array<{
    name: string;
    schemaHash: string;
    mutatesWorkspace: boolean;
    usesMediatedNetwork: boolean;
  }>;
}

export interface AgentCallKeyInput {
  previousJournalKey: string;
  operationIdentity: string;
  semanticInputHash: string;
  finishSchemaHash: string;
  inputArtifactDigests: readonly string[];
  network: "none" | "research";
  preWorkspaceHash: string;
  profile: AgentProfileSnapshot;
  route: AgentRouteSnapshot;
  tools: readonly AgentToolDescriptor[];
}

export type AgentSemanticKeyInput = Omit<AgentCallKeyInput, "previousJournalKey" | "operationIdentity">;

export function agentCallProvenance(
  profile: AgentProfileSnapshot,
  route: AgentRouteSnapshot,
  tools: readonly AgentToolDescriptor[],
): AgentCallProvenance {
  if (route.profileId !== profile.id) {
    throw new Error(`Route ${route.id} belongs to ${route.profileId}, not ${profile.id}`);
  }
  return {
    profileId: profile.id,
    profileHash: profile.hash,
    ...exactRouteIdentity(route),
    tools: tools.map((tool) => ({
      name: tool.name,
      schemaHash: tool.schemaHash,
      mutatesWorkspace: tool.mutatesWorkspace,
      usesMediatedNetwork: tool.usesMediatedNetwork,
    })),
  };
}

/**
 * Route identity is semantic replay identity; auth material, executable paths,
 * cgroup settings, and temporary paths are intentionally not accepted here.
 */
export function buildAgentCallKey(input: AgentCallKeyInput): string {
  return buildWorkflowCallKey({
    previousJournalKey: input.previousJournalKey,
    operation: {
      path: input.operationIdentity,
      sourceId: input.operationIdentity.slice(input.operationIdentity.lastIndexOf(":") + 1),
      kind: operationKind(input.operationIdentity),
      semanticInputHash: input.semanticInputHash,
    },
    semanticKey: buildAgentSemanticKey(input),
  });
}

/** Agent-only semantic key. Its exact field list cannot carry credentials or host paths. */
export function buildAgentSemanticKey(input: AgentSemanticKeyInput): string {
  return stableHash({
    formatVersion: 1,
    semanticInputHash: input.semanticInputHash,
    finishSchemaHash: input.finishSchemaHash,
    inputArtifactDigests: [...input.inputArtifactDigests],
    network: input.network,
    preWorkspaceHash: input.preWorkspaceHash,
    authority: agentCallProvenance(input.profile, input.route, input.tools),
  });
}

function operationKind(operationIdentity: string): import("../runtime/durable-types.js").OperationKind {
  const leaf = operationIdentity.slice(operationIdentity.lastIndexOf("/") + 1);
  const separator = leaf.indexOf(":");
  if (separator < 1) throw new TypeError("Agent operation identity has no kind");
  const kind = leaf.slice(0, separator);
  if (kind !== "agent") throw new TypeError("Agent call key requires an agent operation identity");
  return kind;
}
