import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "../persistence/paths.js";
import { readBoundedTextFile } from "../persistence/safe-paths.js";
import { isThinkingLevel, THINKING_LEVELS } from "../thinking.js";
import { stableHash } from "../utils/hashes.js";
import type { AgentRouteSnapshot, AgentThinkingLevel } from "./executor.js";

export interface AgentRouteTarget {
  /** Exact `provider/model` identity understood by Pi's model registry. */
  model: string;
  thinking: AgentThinkingLevel;
}

export type AgentRouteMap = Readonly<Record<string, AgentRouteTarget>>;

export interface AgentRouteFile {
  routes: AgentRouteMap;
}

export interface AgentRouteRegistryRefreshOptions {
  /** Lowest precedence, normally supplied by the interactive host. */
  defaults?: AgentRouteMap;
  /** Defaults to the machine-local workflow route file. */
  filePath?: string;
  /** Highest precedence, intended for tests and explicit host policy. */
  overrides?: AgentRouteMap;
}

interface RegisteredRoute {
  target: AgentRouteTarget;
  source: "default" | "local" | "override";
}

const PROFILE_ID = /^(?:builtin|user|project):[a-z][a-z0-9_-]{0,63}$/;
const ROUTE_FILE_BYTES = 256 * 1024;

export function workflowRouteFile(agentDir = getAgentDir()): string {
  return path.join(path.resolve(agentDir), "workflow-routes.json");
}

/**
 * Machine-local profile → model routing. Precedence is deliberately small and
 * obvious: explicit override > local file > host default.
 */
export class AgentRouteRegistry {
  private routes = new Map<string, RegisteredRoute>();

  constructor(layers?: {
    defaults?: AgentRouteMap;
    local?: AgentRouteMap;
    overrides?: AgentRouteMap;
  }) {
    if (layers) this.replace(layers);
  }

  async refresh(options: AgentRouteRegistryRefreshOptions = {}): Promise<void> {
    let local: AgentRouteMap = {};
    const filePath = options.filePath ?? workflowRouteFile();
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Agent route registry must be a regular non-symlink file: ${filePath}`);
      }
      local = parseAgentRouteFile(await readBoundedTextFile(filePath, ROUTE_FILE_BYTES), filePath).routes;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.replace({ defaults: options.defaults, local, overrides: options.overrides });
  }

  replace(layers: {
    defaults?: AgentRouteMap;
    local?: AgentRouteMap;
    overrides?: AgentRouteMap;
  }): void {
    const next = new Map<string, RegisteredRoute>();
    addLayer(next, layers.defaults, "default");
    addLayer(next, layers.local, "local");
    addLayer(next, layers.overrides, "override");
    this.routes = next;
  }

  list(): AgentRouteSnapshot[] {
    return [...this.routes.keys()].sort().map((profileId) => this.resolve(profileId));
  }

  source(profileId: string): RegisteredRoute["source"] | undefined {
    return this.routes.get(profileId)?.source;
  }

  resolve(profileId: string): AgentRouteSnapshot {
    assertProfileId(profileId);
    const registered = this.routes.get(profileId);
    if (!registered) throw new Error(`Missing model route for agent profile ${profileId}`);
    return snapshotRoute(profileId, registered.target);
  }

  snapshot(profileIds: readonly string[], availableModels: readonly string[]): {
    routes: AgentRouteSnapshot[];
    hash: string;
  } {
    if (availableModels.length === 0 && profileIds.length > 0) {
      throw new Error("No exact models are available for workflow agent routes");
    }
    const available = new Set(availableModels.map((model) => validateExactModel(model, "available model")));
    const routes = [...new Set(profileIds)].sort().map((profileId) => {
      const route = this.resolve(profileId);
      if (!available.has(route.model)) {
        throw new Error(`Model ${route.model} routed for ${profileId} is unavailable`);
      }
      return route;
    });
    return { routes, hash: stableHash(routes.map(routeIdentity)) };
  }
}

export function parseAgentRouteFile(source: string, filePath = "<routes>"): AgentRouteFile {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Agent route registry ${filePath} is not JSON: ${errorMessage(error)}`);
  }
  if (!plainRecord(value)) throw new Error(`Agent route registry ${filePath} must be an object`);
  assertOnlyKeys(value, new Set(["routes"]), `Agent route registry ${filePath}`);
  if (!plainRecord(value.routes)) throw new Error(`Agent route registry ${filePath} routes must be an object`);
  const routes: Record<string, AgentRouteTarget> = {};
  for (const [profileId, target] of Object.entries(value.routes)) {
    assertProfileId(profileId);
    routes[profileId] = normalizeTarget(target, `route for ${profileId}`);
  }
  return Object.freeze({ routes: Object.freeze(routes) });
}

export function exactRouteIdentity(route: AgentRouteSnapshot): {
  routeId: string;
  routeHash: string;
  provider: string;
  model: string;
  thinking: AgentThinkingLevel;
} {
  return {
    routeId: route.id,
    routeHash: route.hash,
    provider: route.provider,
    model: route.model,
    thinking: route.thinking,
  };
}

function snapshotRoute(profileId: string, targetInput: AgentRouteTarget): AgentRouteSnapshot {
  const target = normalizeTarget(targetInput, `route for ${profileId}`);
  const provider = target.model.slice(0, target.model.indexOf("/"));
  const body = { profileId, provider, model: target.model, thinking: target.thinking };
  const hash = stableHash(body);
  return Object.freeze({
    id: `route_${hash.slice(7, 39)}`,
    ...body,
    hash,
  });
}

function routeIdentity(route: AgentRouteSnapshot): object {
  return {
    id: route.id,
    profileId: route.profileId,
    provider: route.provider,
    model: route.model,
    thinking: route.thinking,
    hash: route.hash,
  };
}

function addLayer(
  target: Map<string, RegisteredRoute>,
  routes: AgentRouteMap | undefined,
  source: RegisteredRoute["source"],
): void {
  if (!routes) return;
  if (!plainRecord(routes)) throw new Error(`${source} agent routes must be an object`);
  for (const [profileId, route] of Object.entries(routes)) {
    assertProfileId(profileId);
    target.set(profileId, { target: normalizeTarget(route, `${source} route for ${profileId}`), source });
  }
}

function normalizeTarget(value: unknown, label: string): AgentRouteTarget {
  if (!plainRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, new Set(["model", "thinking"]), label);
  const model = validateExactModel(value.model, `${label} model`);
  if (!isThinkingLevel(value.thinking)) {
    throw new Error(`${label} thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return Object.freeze({ model, thinking: value.thinking });
}

function validateExactModel(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[^\s/][^\s]*$/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be an exact provider/model identifier`);
  }
  return value;
}

function assertProfileId(value: string): void {
  if (!PROFILE_ID.test(value)) throw new Error(`Invalid routed agent profile id ${value}`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
