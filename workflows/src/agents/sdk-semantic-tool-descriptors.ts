import { Type } from "typebox";
import { stableHash } from "../utils/hashes.js";
import type { AgentToolDescriptor } from "./executor.js";

export const DELETE_FILE_PARAMETERS = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_096, description: "File path below the candidate workspace" }),
}, { additionalProperties: false });

export const WORKSPACE_COMMAND_PARAMETERS = Type.Object({
  argv: Type.Array(Type.String({ minLength: 1, maxLength: 16_384 }), { minItems: 1, maxItems: 256 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
}, { additionalProperties: false });

export const WEB_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 4_096 }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

export const WEB_FETCH_PARAMETERS = Type.Object({
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
