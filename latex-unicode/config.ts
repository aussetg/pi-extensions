// @ts-ignore Node built-ins are available in the Pi runtime.
import { readFileSync } from "node:fs";
// @ts-ignore Node built-ins are available in the Pi runtime.
import { homedir } from "node:os";
// @ts-ignore Node built-ins are available in the Pi runtime.
import { join } from "node:path";

declare const process: { env: Record<string, string | undefined> };

export type LatexUnicodeMode = "render" | "rewrite";

export interface LoadedConfig {
	mode: LatexUnicodeMode;
	path: string;
	warning?: string;
}

const CONFIG_FILE_NAME = "latex-unicode.json";
const DEFAULT_MODE: LatexUnicodeMode = "render";

export function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, CONFIG_FILE_NAME);
}

export function parseConfig(value: unknown, path = CONFIG_FILE_NAME): LoadedConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { mode: DEFAULT_MODE, path, warning: `${path} must contain a JSON object; using render.` };
	}
	const mode = (value as { mode?: unknown }).mode;
	if (mode === undefined || mode === "render") return { mode: DEFAULT_MODE, path };
	if (mode === "rewrite") return { mode, path };
	return {
		mode: DEFAULT_MODE,
		path,
		warning: `${path}: mode must be "render" or "rewrite"; using render.`,
	};
}

export function loadConfig(path = configPath()): LoadedConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		if ((error as { code?: unknown })?.code === "ENOENT") return { mode: DEFAULT_MODE, path };
		const message = error instanceof Error ? error.message : String(error);
		return { mode: DEFAULT_MODE, path, warning: `Could not read ${path}: ${message}; using render.` };
	}
}
