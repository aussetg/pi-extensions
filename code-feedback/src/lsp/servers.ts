import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommand } from "../command-path.ts";
import { resolvePythonEnvironment, type LanguageEnvironment } from "../language-environments.ts";
import { isInsideOrEqual } from "../paths.ts";
import { isRecord } from "../types.ts";
import type { ConfiguredLanguageServer, ConfiguredLanguageServers, EnabledLanguageServerConfig, LanguageServerRole } from "./server-config.ts";

export interface LanguageServerDefinition {
  id: string;
  role: LanguageServerRole;
  command: string;
  args: string[];
  extensions: string[];
  rootMarkers: string[];
  languageId(filePath: string): string;
  env?: NodeJS.ProcessEnv;
  environment?: LanguageEnvironment;
  initializationOptions?: unknown;
  workspaceConfiguration?: Record<string, unknown>;
  configurationKey?: string;
}

export interface ResolvedLanguageServer {
  definition: LanguageServerDefinition;
  root: string;
  available: boolean;
  unavailableReason?: string;
}

export interface LanguageServerResolutionOptions {
  serverOverrides?: Record<string, unknown>;
  serverConfiguration?: ConfiguredLanguageServers;
  projectRoot?: string;
  trustedEnvironmentRoots?: string[];
  server?: string;
  rootCache?: LanguageServerRootCache;
}

export type LanguageServerRootCache = Map<string, { root: string; expiresAt: number }>;

interface RegisteredLanguageServer {
  definition: LanguageServerDefinition;
  disabled: boolean;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const CLANGD_EXTENSIONS = [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"];
const HASKELL_EXTENSIONS = [".hs", ".lhs", ".hs-boot", ".cabal"];

const TYPESCRIPT_ROOT_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json"];
const PYTHON_ROOT_MARKERS = ["pyproject.toml", "uv.lock", "poetry.lock", "Pipfile", "setup.cfg", "setup.py", "requirements.txt"];
const HASKELL_ROOT_MARKERS = ["hie.yaml", "cabal.project", "cabal.project.local", "stack.yaml", "package.yaml"];
const CLANGD_ROOT_MARKERS = [".clangd", "compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "meson.build"];
const LANGUAGE_SERVER_ROOT_CACHE_TTL_MS = 5_000;
const MAX_LANGUAGE_SERVER_ROOT_CACHE_ENTRIES = 1_000;

const DEFAULT_SERVERS: LanguageServerDefinition[] = [
  {
    id: "typescript",
    role: "language",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: TYPESCRIPT_EXTENSIONS,
    rootMarkers: TYPESCRIPT_ROOT_MARKERS,
    languageId: jsTsLanguageId,
  },
  {
    id: "python",
    role: "language",
    command: "ty",
    args: ["server"],
    extensions: [".py", ".pyi"],
    rootMarkers: PYTHON_ROOT_MARKERS,
    languageId: () => "python",
  },
  {
    id: "python-ruff",
    role: "linter",
    command: "ruff",
    args: ["server"],
    extensions: [".py", ".pyi"],
    rootMarkers: PYTHON_ROOT_MARKERS,
    languageId: () => "python",
  },
  {
    id: "rust",
    role: "language",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    languageId: () => "rust",
  },
  {
    id: "go",
    role: "language",
    command: "gopls",
    args: [],
    extensions: [".go"],
    rootMarkers: ["go.work", "go.mod"],
    languageId: () => "go",
  },
  {
    id: "haskell",
    role: "language",
    command: "haskell-language-server-wrapper",
    args: ["--lsp"],
    extensions: HASKELL_EXTENSIONS,
    rootMarkers: HASKELL_ROOT_MARKERS,
    languageId: haskellLanguageId,
    workspaceConfiguration: {
      haskell: {
        plugin: {
          hlint: {
            globalOn: true,
            diagnosticsOn: true,
            codeActionsOn: true,
          },
        },
      },
    },
  },
  {
    id: "clangd",
    role: "language",
    command: "clangd",
    args: [],
    extensions: CLANGD_EXTENSIONS,
    rootMarkers: CLANGD_ROOT_MARKERS,
    languageId: clangdLanguageId,
  },
  {
    id: "json",
    role: "language",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    rootMarkers: ["package.json"],
    languageId: (filePath) => (filePath.endsWith(".jsonc") ? "jsonc" : "json"),
  },
  {
    id: "css",
    role: "language",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".sass", ".less"],
    rootMarkers: ["package.json"],
    languageId: cssLanguageId,
  },
  {
    id: "html",
    role: "language",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
    rootMarkers: ["package.json"],
    languageId: () => "html",
  },
  {
    id: "yaml",
    role: "language",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    rootMarkers: [],
    languageId: () => "yaml",
  },
  {
    id: "lua",
    role: "language",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc"],
    languageId: () => "lua",
  },
];

export function resolveLanguageServers(filePath: string, options: LanguageServerResolutionOptions = {}): ResolvedLanguageServer[] {
  const extension = path.extname(filePath).toLowerCase();
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(filePath));
  const trustedEnvironmentRoots = options.trustedEnvironmentRoots ?? [];
  const routes = registeredLanguageServers(options.serverConfiguration)
    .filter((route) => route.definition.extensions.includes(extension))
    .filter((route) => options.server === undefined || route.definition.id === options.server);
  return routes.map((route) => {
    const root = resolveCachedLanguageServerRoot(filePath, projectRoot, route.definition.rootMarkers, options.rootCache);
    return resolveOneLanguageServer(
      route.definition,
      route.disabled,
      filePath,
      options.serverOverrides,
      root,
      projectRoot,
      trustedEnvironmentRoots,
    );
  });
}

export function resolveLanguageServerRoot(filePath: string, boundaryRoot: string, rootMarkers: readonly string[]): string {
  const boundary = path.resolve(boundaryRoot);
  const resolvedFile = path.resolve(filePath);
  if (rootMarkers.length === 0 || !isInsideOrEqual(resolvedFile, boundary)) return boundary;

  const markers = new Set(rootMarkers);
  let directory = path.dirname(resolvedFile);
  while (isInsideOrEqual(directory, boundary)) {
    if (directoryContainsMarker(directory, markers)) return directory;
    if (directory === boundary) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return boundary;
}

export function configuredLanguageServerIds(configuration: ConfiguredLanguageServers | undefined): string[] {
  return [...new Set([...DEFAULT_SERVERS.map((server) => server.id), ...Object.keys(configuration ?? {})])]
    .sort((left, right) => left.localeCompare(right));
}

export function languageServerExtensions(configuration: ConfiguredLanguageServers | undefined, server?: string): Set<string> {
  return new Set(registeredLanguageServers(configuration)
    .filter((route) => !route.disabled)
    .filter((route) => server === undefined || route.definition.id === server)
    .flatMap((route) => route.definition.extensions));
}

export function languageServerRootMarkers(configuration: ConfiguredLanguageServers | undefined): Set<string> {
  return new Set(registeredLanguageServers(configuration)
    .filter((route) => !route.disabled)
    .flatMap((route) => route.definition.rootMarkers));
}

function resolveCachedLanguageServerRoot(
  filePath: string,
  boundaryRoot: string,
  rootMarkers: readonly string[],
  cache: LanguageServerRootCache | undefined,
): string {
  if (!cache || rootMarkers.length === 0) return resolveLanguageServerRoot(filePath, boundaryRoot, rootMarkers);

  const key = languageServerRootCacheKey(filePath, boundaryRoot, rootMarkers);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.root;
  if (cached) cache.delete(key);

  const root = resolveLanguageServerRoot(filePath, boundaryRoot, rootMarkers);
  if (cache.size >= MAX_LANGUAGE_SERVER_ROOT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { root, expiresAt: now + LANGUAGE_SERVER_ROOT_CACHE_TTL_MS });
  return root;
}

function languageServerRootCacheKey(filePath: string, boundaryRoot: string, rootMarkers: readonly string[]): string {
  const markers = [...rootMarkers].sort((left, right) => left.localeCompare(right));
  return `${path.resolve(boundaryRoot)}\0${path.dirname(path.resolve(filePath))}\0${markers.join("\0")}`;
}

function registeredLanguageServers(configuration: ConfiguredLanguageServers | undefined): RegisteredLanguageServer[] {
  const registered: RegisteredLanguageServer[] = [];
  const builtInIds = new Set(DEFAULT_SERVERS.map((server) => server.id));

  for (const builtIn of DEFAULT_SERVERS) {
    const configured = configuration?.[builtIn.id];
    if (!configured) {
      registered.push({ definition: builtIn, disabled: false });
    } else if (configured.disabled) {
      registered.push({
        definition: {
          ...builtIn,
          configurationKey: configurationKey(configured),
        },
        disabled: true,
      });
    } else {
      registered.push({ definition: definitionFromConfig(builtIn.id, configured), disabled: false });
    }
  }

  for (const [id, configured] of Object.entries(configuration ?? {})) {
    if (builtInIds.has(id) || configured.disabled) continue;
    registered.push({ definition: definitionFromConfig(id, configured), disabled: false });
  }

  return registered;
}

function definitionFromConfig(id: string, configured: EnabledLanguageServerConfig): LanguageServerDefinition {
  const [command, ...args] = configured.command;
  return {
    id,
    role: configured.role ?? "language",
    command,
    args,
    extensions: [...configured.extensions],
    rootMarkers: [...(configured.rootMarkers ?? [])],
    languageId: configuredLanguageId(configured),
    env: configured.env ? { ...configured.env } : undefined,
    initializationOptions: configured.initializationOptions,
    workspaceConfiguration: configured.workspaceConfiguration ? { ...configured.workspaceConfiguration } : undefined,
    configurationKey: configurationKey(configured),
  };
}

function configuredLanguageId(configured: EnabledLanguageServerConfig): (filePath: string) => string {
  return (filePath) => {
    const extension = path.extname(filePath).toLowerCase();
    return configured.languageIds?.[extension] ?? configured.languageId ?? (extension.slice(1) || "plaintext");
  };
}

function configurationKey(configured: ConfiguredLanguageServer): string {
  return JSON.stringify(configured);
}

function resolveOneLanguageServer(
  base: LanguageServerDefinition,
  disabled: boolean,
  filePath: string,
  overrides: Record<string, unknown> | undefined,
  root: string,
  projectRoot: string,
  trustedEnvironmentRoots: string[],
): ResolvedLanguageServer {
  if (disabled) {
    return {
      definition: base,
      root,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const definition = applyOverride(base, overrides?.[base.id]);
  if (!definition) {
    return {
      definition: base,
      root,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const environment = languageEnvironmentForServer(definition, filePath, projectRoot, trustedEnvironmentRoots);
  const command = relativeCommandFromProject(definition.command, projectRoot);
  const resolvedCommand = resolveCommand(command, path.dirname(filePath), projectRoot, { extraBinDirs: environment?.binDirs });
  const available = resolvedCommand !== undefined;
  const resolvedDefinition = resolvedCommand
    ? withLanguageEnvironment({ ...definition, command: resolvedCommand }, environment)
    : withLanguageEnvironment(definition, environment);
  return {
    definition: resolvedDefinition,
    root,
    available,
    unavailableReason: available ? undefined : `command not found on PATH or node_modules/.bin: ${definition.command}`,
  };
}

function directoryContainsMarker(directory: string, markers: ReadonlySet<string>): boolean {
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (markers.has(entry)) return true;
    }
  } catch {
    // An unreadable directory cannot establish a more specific workspace.
  }
  return false;
}

function relativeCommandFromProject(command: string, projectRoot: string): string {
  return !path.isAbsolute(command) && (command.includes(path.sep) || command.includes("/"))
    ? path.resolve(projectRoot, command)
    : command;
}

function languageEnvironmentForServer(definition: LanguageServerDefinition, filePath: string, projectRoot: string, trustedEnvironmentRoots: string[]): LanguageEnvironment | undefined {
  if (!definition.extensions.some((extension) => extension === ".py" || extension === ".pyi")) return undefined;
  return resolvePythonEnvironment(filePath, projectRoot, trustedEnvironmentRoots);
}

function withLanguageEnvironment(definition: LanguageServerDefinition, environment: LanguageEnvironment | undefined): LanguageServerDefinition {
  if (!environment) return definition;
  return {
    ...definition,
    env: { ...definition.env, ...environment.env },
    environment,
    initializationOptions: initializationOptionsForServer(definition, environment),
    workspaceConfiguration: workspaceConfigurationForServer(definition, environment),
  };
}

function initializationOptionsForServer(definition: LanguageServerDefinition, environment: LanguageEnvironment): unknown {
  if (isPyrightLikeServer(definition)) {
    return {
      python: {
        defaultInterpreterPath: environment.executable,
        pythonPath: environment.executable,
        analysis: {
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
        },
      },
    };
  }
  return definition.initializationOptions;
}

function workspaceConfigurationForServer(definition: LanguageServerDefinition, environment: LanguageEnvironment): Record<string, unknown> | undefined {
  if (path.basename(definition.command) === "ty") return tyWorkspaceConfiguration(environment);
  if (isPyrightLikeServer(definition)) return pyrightWorkspaceConfiguration(environment);
  return definition.workspaceConfiguration;
}

function tyWorkspaceConfiguration(environment: LanguageEnvironment): Record<string, unknown> {
  const activeEnvironment = {
    executable: {
      uri: environment.executable ? pathToFileURL(environment.executable).href : undefined,
      sysPrefix: environment.root,
    },
  };
  return {
    ty: { pythonExtension: { activeEnvironment } },
    pythonExtension: { activeEnvironment },
  };
}

function pyrightWorkspaceConfiguration(environment: LanguageEnvironment): Record<string, unknown> {
  const venvDir = environment.root;
  const venvParent = path.dirname(venvDir);
  const venvName = path.basename(venvDir);
  const python = {
    pythonPath: environment.executable,
    defaultInterpreterPath: environment.executable,
    analysis: {
      autoSearchPaths: true,
      useLibraryCodeForTypes: true,
    },
  };
  const settings = {
    venvPath: venvParent,
    venv: venvName,
    python,
    pythonPath: environment.executable,
    defaultInterpreterPath: environment.executable,
  };
  return {
    ...settings,
    python,
    pyright: settings,
    basedpyright: settings,
  };
}

function isPyrightLikeServer(definition: LanguageServerDefinition): boolean {
  const command = path.basename(definition.command);
  return command === "pyright-langserver" || command === "basedpyright-langserver";
}

function applyOverride(base: LanguageServerDefinition, value: unknown): LanguageServerDefinition | undefined {
  if (!isRecord(value)) return base;
  const override = value;
  if (override.disabled === true) return undefined;

  const command = typeof override.command === "string" && override.command.length > 0 ? override.command : base.command;
  const args = Array.isArray(override.args) && override.args.every((arg) => typeof arg === "string") ? override.args : base.args;
  const languageIdOverride = typeof override.languageId === "string" && override.languageId.length > 0 ? override.languageId : undefined;

  return {
    ...base,
    command,
    args,
    languageId: languageIdOverride ? () => languageIdOverride : base.languageId,
    configurationKey: `${base.configurationKey ?? "built-in"}\0override:${JSON.stringify(override)}`,
  };
}

function jsTsLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "typescript";
  }
}

function cssLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".scss":
      return "scss";
    case ".sass":
      return "sass";
    case ".less":
      return "less";
    default:
      return "css";
  }
}

function clangdLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".c" || extension === ".h" ? "c" : "cpp";
}

function haskellLanguageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".lhs") return "literate haskell";
  if (extension === ".cabal") return "cabal";
  return "haskell";
}

