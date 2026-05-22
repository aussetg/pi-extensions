import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

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
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageId: (filePath) => (filePath.endsWith(".pyi") ? "python" : "python"),
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

export function resolveLanguageServer(filePath: string, overrides: Record<string, unknown> | undefined): ResolvedLanguageServer | undefined {
  const extension = path.extname(filePath).toLowerCase();
  const base = DEFAULT_SERVERS.find((server) => server.extensions.includes(extension));
  if (!base) return undefined;

  const definition = applyOverride(base, overrides?.[base.id]);
  if (!definition) {
    return {
      definition: base,
      available: false,
      unavailableReason: "disabled by config",
    };
  }

  const available = commandExists(definition.command);
  return {
    definition,
    available,
    unavailableReason: available ? undefined : `command not found on PATH: ${definition.command}`,
  };
}

export function listDefaultServerDefinitions(): LanguageServerDefinition[] {
  return [...DEFAULT_SERVERS];
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

function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return fs.existsSync(command);
  }

  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

