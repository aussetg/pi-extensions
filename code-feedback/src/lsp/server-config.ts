import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, isErrorCode } from "../errors.ts";
import { isRecord, type LspServerConfigurationSourceStatus, type LspServerConfigurationStatus } from "../types.ts";

export const LANGUAGE_SERVER_CONFIG_FILE = "code-feedback.json";
const MAX_CONFIG_BYTES = 1_048_576;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVER_FIELDS = new Set([
  "disabled",
  "command",
  "extensions",
  "languageId",
  "languageIds",
  "rootMarkers",
  "role",
  "env",
  "initializationOptions",
  "workspaceConfiguration",
]);

export type LanguageServerRole = "language" | "linter";

export interface EnabledLanguageServerConfig {
  disabled?: false;
  command: readonly string[];
  extensions: readonly string[];
  languageId?: string;
  languageIds?: Record<string, string>;
  rootMarkers?: readonly string[];
  role?: LanguageServerRole;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  workspaceConfiguration?: Record<string, unknown>;
}

export interface DisabledLanguageServerConfig {
  disabled: true;
}

export type ConfiguredLanguageServer = EnabledLanguageServerConfig | DisabledLanguageServerConfig;
export type ConfiguredLanguageServers = Readonly<Record<string, ConfiguredLanguageServer>>;

export interface LanguageServerConfiguration {
  servers: ConfiguredLanguageServers;
  status: LspServerConfigurationStatus;
}

export interface LoadLanguageServerConfigurationOptions {
  agentDir: string;
  projectRoot: string;
  configDirName: string;
  projectTrusted: boolean;
}

interface ParsedConfigSource {
  servers: Record<string, ConfiguredLanguageServer>;
  status: LspServerConfigurationSourceStatus;
  error?: string;
}

export function loadLanguageServerConfiguration(options: LoadLanguageServerConfigurationOptions): LanguageServerConfiguration {
  const userPath = path.join(path.resolve(options.agentDir), LANGUAGE_SERVER_CONFIG_FILE);
  const projectPath = path.join(path.resolve(options.projectRoot), options.configDirName, LANGUAGE_SERVER_CONFIG_FILE);
  const user = readConfigSource("user", userPath);
  const project: ParsedConfigSource = options.projectTrusted
    ? readConfigSource("project", projectPath)
    : {
        servers: {},
        status: { scope: "project", path: projectPath, state: "ignored-untrusted" },
      };

  const servers: Record<string, ConfiguredLanguageServer> = Object.create(null);
  for (const [id, server] of Object.entries(user.servers)) servers[id] = server;
  for (const [id, server] of Object.entries(project.servers)) servers[id] = server;

  const errors = [user.error, project.error].filter((error): error is string => error !== undefined);
  return {
    servers: Object.freeze(servers),
    status: {
      sources: [user.status, project.status],
      configuredServerIds: Object.keys(servers).sort((left, right) => left.localeCompare(right)),
      errors,
    },
  };
}

function readConfigSource(scope: "user" | "project", filePath: string): ParsedConfigSource {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { servers: {}, status: { scope, path: filePath, state: "missing" } };
    }
    return invalidSource(scope, filePath, `cannot stat file: ${errorMessage(error)}`);
  }

  if (!stat.isFile()) return invalidSource(scope, filePath, "path is not a regular file");
  if (stat.size > MAX_CONFIG_BYTES) {
    return invalidSource(scope, filePath, `file is too large (${stat.size} bytes > ${MAX_CONFIG_BYTES} byte limit)`);
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return invalidSource(scope, filePath, `cannot read file: ${errorMessage(error)}`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CONFIG_BYTES) {
    return invalidSource(scope, filePath, `file is too large (${bytes} bytes > ${MAX_CONFIG_BYTES} byte limit)`);
  }

  try {
    return {
      servers: parseConfig(text),
      status: { scope, path: filePath, state: "loaded" },
    };
  } catch (error) {
    return invalidSource(scope, filePath, errorMessage(error));
  }
}

function invalidSource(scope: "user" | "project", filePath: string, message: string): ParsedConfigSource {
  return {
    servers: {},
    status: { scope, path: filePath, state: "invalid" },
    error: `${filePath}: ${message}`,
  };
}

function parseConfig(text: string): Record<string, ConfiguredLanguageServer> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(value)) throw new Error("config must be a JSON object");
  const unknownTopLevelFields = Object.keys(value).filter((key) => key !== "servers");
  if (unknownTopLevelFields.length > 0) {
    throw new Error(`unknown top-level field${unknownTopLevelFields.length === 1 ? "" : "s"}: ${unknownTopLevelFields.join(", ")}`);
  }
  if (!isRecord(value.servers)) throw new Error("config requires an object-valued \"servers\" field");

  const servers: Record<string, ConfiguredLanguageServer> = Object.create(null);
  for (const [id, server] of Object.entries(value.servers)) {
    validateServerId(id);
    servers[id] = parseServer(id, server);
  }
  return servers;
}

function parseServer(id: string, value: unknown): ConfiguredLanguageServer {
  if (!isRecord(value)) throw new Error(`servers.${id} must be an object`);
  const unknownFields = Object.keys(value).filter((key) => !SERVER_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new Error(`servers.${id} has unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
  }

  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    throw new Error(`servers.${id}.disabled must be a boolean`);
  }
  const disabled = value.disabled === true;
  if (disabled) {
    const ignoredFields = Object.keys(value).filter((key) => key !== "disabled");
    if (ignoredFields.length > 0) {
      throw new Error(`servers.${id} is disabled and may not define: ${ignoredFields.join(", ")}`);
    }
    return Object.freeze({ disabled: true });
  }
  const command = value.command === undefined
    ? undefined
    : parseCommand(id, value.command);
  const extensions = value.extensions === undefined
    ? undefined
    : parseExtensions(id, value.extensions);
  if (!command) throw new Error(`servers.${id}.command is required for an enabled server`);
  if (!extensions) throw new Error(`servers.${id}.extensions is required for an enabled server`);

  const languageId = value.languageId === undefined
    ? undefined
    : parseNonEmptyString(value.languageId, `servers.${id}.languageId`);
  const languageIds = value.languageIds === undefined
    ? undefined
    : parseLanguageIds(id, value.languageIds, extensions);
  const rootMarkers = value.rootMarkers === undefined
    ? undefined
    : parseRootMarkers(id, value.rootMarkers);
  const role = value.role === undefined
    ? undefined
    : parseServerRole(id, value.role);
  const env = value.env === undefined ? undefined : parseEnvironment(id, value.env);
  const workspaceConfiguration = value.workspaceConfiguration === undefined
    ? undefined
    : parseObject(value.workspaceConfiguration, `servers.${id}.workspaceConfiguration`);

  return Object.freeze({
    disabled: false,
    command,
    extensions,
    languageId,
    languageIds,
    rootMarkers,
    role,
    env,
    initializationOptions: value.initializationOptions,
    workspaceConfiguration,
  });
}

function parseRootMarkers(id: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`servers.${id}.rootMarkers must be a non-empty string array`);
  }
  const markers = value.map((entry, index) => parseRootMarker(entry, `servers.${id}.rootMarkers[${index}]`));
  if (new Set(markers).size !== markers.length) throw new Error(`servers.${id}.rootMarkers contains duplicates`);
  return Object.freeze(markers);
}

function parseRootMarker(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    throw new Error(`${label} must be a trimmed basename no longer than 255 UTF-8 bytes`);
  }
  return value;
}

function parseServerRole(id: string, value: unknown): LanguageServerRole {
  if (value !== "language" && value !== "linter") {
    throw new Error(`servers.${id}.role must be "language" or "linter"`);
  }
  return value;
}

function parseCommand(id: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && !entry.includes("\0"))) {
    throw new Error(`servers.${id}.command must be a non-empty string array`);
  }
  if (value[0].trim().length === 0) throw new Error(`servers.${id}.command[0] must not be blank`);
  return Object.freeze([...value]);
}

function parseExtensions(id: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`servers.${id}.extensions must be a non-empty string array`);
  }
  const extensions = value.map((entry, index) => normalizeExtension(entry, `servers.${id}.extensions[${index}]`));
  if (new Set(extensions).size !== extensions.length) throw new Error(`servers.${id}.extensions contains duplicates`);
  return Object.freeze(extensions);
}

function parseLanguageIds(id: string, value: unknown, extensions: readonly string[] | undefined): Record<string, string> {
  if (!isRecord(value)) throw new Error(`servers.${id}.languageIds must be an object`);
  const languageIds: Record<string, string> = Object.create(null);
  for (const [rawExtension, rawLanguageId] of Object.entries(value)) {
    const extension = normalizeExtension(rawExtension, `servers.${id}.languageIds key`);
    if (Object.hasOwn(languageIds, extension)) {
      throw new Error(`servers.${id}.languageIds contains duplicate normalized extension ${extension}`);
    }
    if (extensions && !extensions.includes(extension)) {
      throw new Error(`servers.${id}.languageIds contains ${extension}, which is not listed in extensions`);
    }
    languageIds[extension] = parseNonEmptyString(rawLanguageId, `servers.${id}.languageIds.${rawExtension}`);
  }
  return Object.freeze(languageIds);
}

function parseEnvironment(id: string, value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error(`servers.${id}.env must be an object`);
  const env: Record<string, string> = Object.create(null);
  for (const [key, rawValue] of Object.entries(value)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new Error(`servers.${id}.env has invalid variable name: ${JSON.stringify(key)}`);
    }
    if (typeof rawValue !== "string" || rawValue.includes("\0")) {
      throw new Error(`servers.${id}.env.${key} must be a string without NUL bytes`);
    }
    env[key] = rawValue;
  }
  return Object.freeze(env);
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return Object.freeze({ ...value });
}

function normalizeExtension(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const extension = value.toLowerCase();
  if (!/^\.[^./\\\s\0]+(?:-[^./\\\s\0]+)*$/.test(extension)) {
    throw new Error(`${label} must be a lowercaseable file extension beginning with a dot`);
  }
  return extension;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} must be a trimmed, non-empty string without NUL bytes`);
  }
  return value;
}

function validateServerId(id: string): void {
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new Error(`invalid server id ${JSON.stringify(id)}; use letters, numbers, dot, underscore, and hyphen`);
  }
}
