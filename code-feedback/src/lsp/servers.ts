import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCommand } from "../command-path.ts";
import { resolveLanguageEnvironment, type LanguageEnvironment } from "../language-environments.ts";

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
}

export interface ResolvedLanguageServer {
  definition: LanguageServerDefinition;
  available: boolean;
  unavailableReason?: string;
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
export function resolveLanguageServer(filePath: string, overrides: Record<string, unknown> | undefined, projectRoot = path.dirname(filePath), trustedEnvironmentRoots: string[] = []): ResolvedLanguageServer | undefined {
  return resolveLanguageServers(filePath, overrides, projectRoot, trustedEnvironmentRoots)[0];
}

export function resolveLanguageServers(filePath: string, overrides: Record<string, unknown> | undefined, projectRoot = path.dirname(filePath), trustedEnvironmentRoots: string[] = []): ResolvedLanguageServer[] {
  const extension = path.extname(filePath).toLowerCase();
  const bases = DEFAULT_SERVERS.filter((server) => server.extensions.includes(extension));
  return bases.map((base) => resolveOneLanguageServer(base, filePath, overrides, projectRoot, trustedEnvironmentRoots));
}

function resolveOneLanguageServer(
  base: LanguageServerDefinition,
  filePath: string,
  overrides: Record<string, unknown> | undefined,
  projectRoot: string,
  trustedEnvironmentRoots: string[],
): ResolvedLanguageServer {
  const definition = applyOverride(base, overrides?.[base.id]);
  if (!definition) {
    return {
      definition: base,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const environment = languageEnvironmentForServer(definition, filePath, projectRoot, trustedEnvironmentRoots);
  const resolvedCommand = resolveCommand(definition.command, path.dirname(filePath), projectRoot, { extraBinDirs: environment?.binDirs });
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

function languageEnvironmentForServer(definition: LanguageServerDefinition, filePath: string, projectRoot: string, trustedEnvironmentRoots: string[]): LanguageEnvironment | undefined {
  if (!definition.extensions.some((extension) => extension === ".py" || extension === ".pyi")) return undefined;
  return resolveLanguageEnvironment("python", filePath, projectRoot, trustedEnvironmentRoots);
}

function withLanguageEnvironment(definition: LanguageServerDefinition, environment: LanguageEnvironment | undefined): LanguageServerDefinition {
  if (!environment) return definition;
  return {
    ...definition,
    env: environment.env,
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

