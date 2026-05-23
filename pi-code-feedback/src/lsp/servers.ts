import * as path from "node:path";
import { resolveCommand } from "../command-path.ts";

export interface LanguageServerDefinition {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId(filePath: string): string;
}

export interface ResolvedLanguageServer {
  definition: LanguageServerDefinition;
  available: boolean;
  unavailableReason?: string;
}

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

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
export function resolveLanguageServer(filePath: string, overrides: Record<string, unknown> | undefined, projectRoot = path.dirname(filePath)): ResolvedLanguageServer | undefined {
  return resolveLanguageServers(filePath, overrides, projectRoot)[0];
}

export function resolveLanguageServers(filePath: string, overrides: Record<string, unknown> | undefined, projectRoot = path.dirname(filePath)): ResolvedLanguageServer[] {
  const extension = path.extname(filePath).toLowerCase();
  const bases = DEFAULT_SERVERS.filter((server) => server.extensions.includes(extension));
  return bases.map((base) => resolveOneLanguageServer(base, filePath, overrides, projectRoot));
}

function resolveOneLanguageServer(
  base: LanguageServerDefinition,
  filePath: string,
  overrides: Record<string, unknown> | undefined,
  projectRoot: string,
): ResolvedLanguageServer {
  const definition = applyOverride(base, overrides?.[base.id]);
  if (!definition) {
    return {
      definition: base,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const resolvedCommand = resolveCommand(definition.command, path.dirname(filePath), projectRoot);
  const available = resolvedCommand !== undefined;
  return {
    definition: resolvedCommand ? { ...definition, command: resolvedCommand } : definition,
    available,
    unavailableReason: available ? undefined : `command not found on PATH or node_modules/.bin: ${definition.command}`,
  };
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

