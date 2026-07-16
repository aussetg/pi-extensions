import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommand } from "../command-path.ts";
import { resolveLanguageEnvironment, type LanguageEnvironment } from "../language-environments.ts";
import type { ConfiguredLanguageServer, ConfiguredLanguageServers, EnabledLanguageServerConfig } from "./server-config.ts";

export interface LanguageServerDefinition {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId(filePath: string): string;
  env?: NodeJS.ProcessEnv;
  environment?: LanguageEnvironment;
  initializationOptions?: unknown;
  workspaceConfiguration?: Record<string, unknown>;
  configurationKey?: string;
}

export interface ResolvedLanguageServer {
  definition: LanguageServerDefinition;
  available: boolean;
  unavailableReason?: string;
}

export interface LanguageServerResolutionOptions {
  serverOverrides?: Record<string, unknown>;
  serverConfiguration?: ConfiguredLanguageServers;
  projectRoot?: string;
  trustedEnvironmentRoots?: string[];
  server?: string;
}

interface RegisteredLanguageServer {
  definition: LanguageServerDefinition;
  disabled: boolean;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const CLANGD_EXTENSIONS = [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"];
const HASKELL_EXTENSIONS = [".hs", ".lhs", ".hs-boot", ".cabal"];

const DEFAULT_SERVERS: LanguageServerDefinition[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: TYPESCRIPT_EXTENSIONS,
    languageId: jsTsLanguageId,
  },
  {
    id: "python",
    command: "ty",
    args: ["server"],
    extensions: [".py", ".pyi"],
    languageId: () => "python",
  },
  {
    id: "python-ruff",
    command: "ruff",
    args: ["server"],
    extensions: [".py", ".pyi"],
    languageId: () => "python",
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageId: () => "rust",
  },
  {
    id: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    languageId: () => "go",
  },
  {
    id: "haskell",
    command: "haskell-language-server-wrapper",
    args: ["--lsp"],
    extensions: HASKELL_EXTENSIONS,
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
    command: "clangd",
    args: [],
    extensions: CLANGD_EXTENSIONS,
    languageId: clangdLanguageId,
  },
  {
    id: "json",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    languageId: (filePath) => (filePath.endsWith(".jsonc") ? "jsonc" : "json"),
  },
  {
    id: "css",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".sass", ".less"],
    languageId: cssLanguageId,
  },
  {
    id: "html",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
    languageId: () => "html",
  },
  {
    id: "yaml",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    languageId: () => "yaml",
  },
  {
    id: "lua",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    languageId: () => "lua",
  },
];

export function resolveLanguageServer(filePath: string, options: LanguageServerResolutionOptions = {}): ResolvedLanguageServer | undefined {
  return resolveLanguageServers(filePath, options)[0];
}

export function resolveLanguageServers(filePath: string, options: LanguageServerResolutionOptions = {}): ResolvedLanguageServer[] {
  const extension = path.extname(filePath).toLowerCase();
  const projectRoot = options.projectRoot ?? path.dirname(filePath);
  const trustedEnvironmentRoots = options.trustedEnvironmentRoots ?? [];
  const routes = registeredLanguageServers(options.serverConfiguration)
    .filter((route) => route.definition.extensions.includes(extension))
    .filter((route) => options.server === undefined || route.definition.id === options.server);
  return routes.map((route) => resolveOneLanguageServer(
    route.definition,
    route.disabled,
    filePath,
    options.serverOverrides,
    projectRoot,
    trustedEnvironmentRoots,
  ));
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
    command,
    args,
    extensions: [...configured.extensions],
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
  projectRoot: string,
  trustedEnvironmentRoots: string[],
): ResolvedLanguageServer {
  if (disabled) {
    return {
      definition: base,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const definition = applyOverride(base, overrides?.[base.id]);
  if (!definition) {
    return {
      definition: base,
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
    available,
    unavailableReason: available ? undefined : `command not found on PATH or node_modules/.bin: ${definition.command}`,
  };
}

function relativeCommandFromProject(command: string, projectRoot: string): string {
  return !path.isAbsolute(command) && (command.includes(path.sep) || command.includes("/"))
    ? path.resolve(projectRoot, command)
    : command;
}

function languageEnvironmentForServer(definition: LanguageServerDefinition, filePath: string, projectRoot: string, trustedEnvironmentRoots: string[]): LanguageEnvironment | undefined {
  if (!definition.extensions.some((extension) => extension === ".py" || extension === ".pyi")) return undefined;
  return resolveLanguageEnvironment("python", filePath, projectRoot, trustedEnvironmentRoots);
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
  if (isTyServer(definition)) return tyWorkspaceConfiguration(environment);
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

function isTyServer(definition: LanguageServerDefinition): boolean {
  return path.basename(definition.command) === "ty";
}

function isPyrightLikeServer(definition: LanguageServerDefinition): boolean {
  const command = path.basename(definition.command);
  return command === "pyright-langserver" || command === "basedpyright-langserver";
}

function applyOverride(base: LanguageServerDefinition, value: unknown): LanguageServerDefinition | undefined {
  if (!value || typeof value !== "object") return base;
  const override = value as { disabled?: unknown; command?: unknown; args?: unknown; languageId?: unknown };
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

