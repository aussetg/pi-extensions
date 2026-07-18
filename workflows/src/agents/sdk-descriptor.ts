import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { stableHash } from "../utils/hashes.js";
import type { AgentExecutorDescriptor, AgentToolDescriptor } from "./executor.js";
import { sdkSemanticToolDescriptors } from "./sdk-semantic-tool-descriptors.js";

/** Exact primary-session view of the physical SDK worker's authority. */
export function sdkAgentWorkerDescriptor(): AgentExecutorDescriptor {
  const builtins = [
    createReadTool("/workspace"),
    createGrepTool("/workspace"),
    createFindTool("/workspace"),
    createLsTool("/workspace"),
    createEditTool("/workspace"),
    createWriteTool("/workspace"),
  ];
  const mutating = new Set(["edit", "write"]);
  const toolCatalog: AgentToolDescriptor[] = [
    ...builtins.map((tool) => ({
      name: tool.name,
      schemaHash: stableHash(tool.parameters).slice(7),
      mutatesWorkspace: mutating.has(tool.name),
      usesMediatedNetwork: false,
    })),
    ...sdkSemanticToolDescriptors(),
  ];
  return {
    id: "pi-sdk-worker",
    capabilities: {
      persistentSessions: true,
      candidateWorkspace: true,
      mediatedNetwork: true,
      liveProgress: true,
      artifactPublication: true,
    },
    toolCatalog,
  };
}
