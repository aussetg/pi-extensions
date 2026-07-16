import fs from "node:fs";
import path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonValue } from "../types.js";
import { stableHash } from "../utils/hashes.js";
import { stableJson } from "../utils/stable-json.js";
import type { AgentExecutionRequest, AgentToolDescriptor } from "./executor.js";
import type { AgentWorkerProtocol } from "./sdk-protocol.js";

const DELETE_FILE_PARAMETERS = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_096, description: "File path below the candidate workspace" }),
}, { additionalProperties: false });

const WORKSPACE_COMMAND_PARAMETERS = Type.Object({
  argv: Type.Array(Type.String({ minLength: 1, maxLength: 16_384 }), { minItems: 1, maxItems: 256 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
}, { additionalProperties: false });

const WEB_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4_096 }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

const WEB_FETCH_PARAMETERS = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 8_192, pattern: "^https://" }),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 2 * 1024 * 1024 })),
}, { additionalProperties: false });

export function sdkSemanticToolDescriptors(): AgentToolDescriptor[] {
  return [
    descriptor("delete_file", DELETE_FILE_PARAMETERS, true, false),
    descriptor("workspace_command", WORKSPACE_COMMAND_PARAMETERS, true, false),
    descriptor("web_search", WEB_SEARCH_PARAMETERS, false, true),
    descriptor("web_fetch", WEB_FETCH_PARAMETERS, false, true),
  ];
}

/** Exact custom tools used by the isolated SDK worker. */
export function createSdkSemanticTools(
  protocol: AgentWorkerProtocol,
  request: AgentExecutionRequest,
): ToolDefinition[] {
  const requested = new Set(request.tools.map((tool) => tool.name));
  const tools: ToolDefinition[] = [];
  if (requested.has("delete_file")) {
    if (request.workspace.mode !== "candidate") throw new Error("delete_file requires a candidate workspace");
    tools.push(defineTool({
      name: "delete_file",
      label: "Delete File",
      description: "Delete one regular file or symbolic link from the disposable candidate workspace.",
      parameters: DELETE_FILE_PARAMETERS,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const deleted = await deleteCandidateFile(request.workspace.root, request.workspace.cwd, params.path);
        return { content: [{ type: "text", text: `Deleted ${deleted}.` }], details: { path: deleted } };
      },
    }));
  }
  if (requested.has("workspace_command")) {
    tools.push(mediatedTool(
      "workspace_command",
      "Workspace Command",
      "Run one argv-only command in the candidate workspace. The command has no network namespace.",
      WORKSPACE_COMMAND_PARAMETERS,
      protocol,
    ));
  }
  if (requested.has("web_search")) {
    tools.push(mediatedTool(
      "web_search",
      "Web Search",
      "Search the web through the coordinator's bounded mediated network service.",
      WEB_SEARCH_PARAMETERS,
      protocol,
    ));
  }
  if (requested.has("web_fetch")) {
    tools.push(mediatedTool(
      "web_fetch",
      "Web Fetch",
      "Fetch one HTTPS source through the coordinator's bounded mediated network service.",
      WEB_FETCH_PARAMETERS,
      protocol,
    ));
  }
  return tools;
}

function mediatedTool(
  name: "workspace_command" | "web_search" | "web_fetch",
  label: string,
  description: string,
  parameters: any,
  protocol: AgentWorkerProtocol,
): ToolDefinition {
  return defineTool({
    name,
    label,
    description,
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const response = await protocol.request(name, toolCallId, json(params));
      return {
        content: [{ type: "text", text: bounded(stableJson(response), 64_000) }],
        details: { response },
      };
    },
  });
}

async function deleteCandidateFile(rootInput: string, cwdInput: string, requested: string): Promise<string> {
  if (requested.includes("\0")) throw new Error("delete_file path contains NUL");
  const root = path.resolve(rootInput);
  const cwd = path.resolve(cwdInput);
  const target = path.resolve(cwd, requested);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("delete_file path escapes the candidate workspace");
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("delete_file path traverses a symbolic link");
  }
  const stat = await fs.promises.lstat(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("delete_file does not remove directories");
  await fs.promises.unlink(target);
  return relative.split(path.sep).join("/");
}

function descriptor(
  name: string,
  parameters: unknown,
  mutatesWorkspace: boolean,
  usesMediatedNetwork: boolean,
): AgentToolDescriptor {
  return {
    name,
    schemaHash: stableHash(parameters).slice(7),
    mutatesWorkspace,
    usesMediatedNetwork,
  };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function bounded(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}
