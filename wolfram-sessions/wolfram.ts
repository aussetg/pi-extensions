import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_IDLE_TTL_SECONDS = "3600";
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_PER_SESSION_MS = 11_000;

type ManagedEnvironment = {
	previousBase: string | undefined;
	previousIdleTtl: string | undefined;
	appliedBase: string;
	appliedIdleTtl: string;
};

let sessionBase: string | undefined;
let sessionId: string | undefined;
let wlSessionScript: string | undefined;
let managedEnvironment: ManagedEnvironment | undefined;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || "unknown";
}

function shortHash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getPiSessionId(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager as unknown as {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};

	const id = manager.getSessionId?.();
	if (id) return id;

	const file = manager.getSessionFile?.();
	if (file) return `${path.basename(file, ".jsonl")}-${shortHash(file)}`;

	return `memory-${shortHash(ctx.cwd)}`;
}

function getSessionBase(ctx: ExtensionContext): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	const defaultRoot = path.join(runtimeDir && path.isAbsolute(runtimeDir) ? runtimeDir : os.tmpdir(), "pi-wolfram-sessions");
	const root = process.env.WL_PI_SESSION_BASE_ROOT ?? defaultRoot;
	return path.join(root, `pi-${sanitize(getPiSessionId(ctx))}`);
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
	const checker = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
	return typeof checker === "function" ? checker.call(ctx) === true : true;
}

function findWlSessionScript(ctx: ExtensionContext): string | undefined {
	const candidates = [
		process.env.WOLFRAM_SESSION_SCRIPT,
		path.join(agentDir(), "skills", "wolfram-mathematica", "scripts", "wl-session"),
		path.join(os.homedir(), ".agents", "skills", "wolfram-mathematica", "scripts", "wl-session"),
	].filter((candidate): candidate is string => Boolean(candidate));

	if (isProjectTrusted(ctx)) {
		candidates.push(
			path.join(ctx.cwd, CONFIG_DIR_NAME, "skills", "wolfram-mathematica", "scripts", "wl-session"),
			path.join(ctx.cwd, ".agents", "skills", "wolfram-mathematica", "scripts", "wl-session"),
		);
	}

	return candidates.find((candidate) => fs.existsSync(candidate));
}

async function runWlSession(pi: ExtensionAPI, base: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	if (!wlSessionScript) {
		return { stdout: "", stderr: "wl-session script not found", code: 127 };
	}

	const ttl = process.env.WL_SESSION_IDLE_TTL ?? DEFAULT_IDLE_TTL_SECONDS;
	const command = [
		`WL_SESSION_BASE=${shellQuote(base)}`,
		`WL_SESSION_IDLE_TTL=${shellQuote(ttl)}`,
		shellQuote(wlSessionScript),
		...args.map(shellQuote),
	].join(" ");

	return await pi.exec("bash", ["-lc", command], { timeout: commandTimeoutMs(base, args) });
}

function commandTimeoutMs(base: string, args: string[]): number {
	if (args[0] !== "stop-all") return DEFAULT_COMMAND_TIMEOUT_MS;

	try {
		let sessionCount = 0;
		for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
			if (entry.isDirectory()) sessionCount += 1;
		}
		return Math.max(DEFAULT_COMMAND_TIMEOUT_MS, 5_000 + sessionCount * STOP_TIMEOUT_PER_SESSION_MS);
	} catch {
		return DEFAULT_COMMAND_TIMEOUT_MS;
	}
}

function configureEnvironment(ctx: ExtensionContext) {
	const nextSessionId = getPiSessionId(ctx);
	const nextSessionBase = getSessionBase(ctx);
	const nextWlSessionScript = findWlSessionScript(ctx);

	fs.mkdirSync(nextSessionBase, { recursive: true, mode: 0o700 });
	fs.chmodSync(nextSessionBase, 0o700);
	restoreEnvironment();

	const previousBase = process.env.WL_SESSION_BASE;
	const previousIdleTtl = process.env.WL_SESSION_IDLE_TTL;
	const appliedIdleTtl = previousIdleTtl ?? DEFAULT_IDLE_TTL_SECONDS;
	process.env.WL_SESSION_BASE = nextSessionBase;
	process.env.WL_SESSION_IDLE_TTL = appliedIdleTtl;
	managedEnvironment = {
		previousBase,
		previousIdleTtl,
		appliedBase: nextSessionBase,
		appliedIdleTtl,
	};

	sessionId = nextSessionId;
	sessionBase = nextSessionBase;
	wlSessionScript = nextWlSessionScript;
}

function restoreEnvironment(): void {
	if (!managedEnvironment) return;

	if (process.env.WL_SESSION_BASE === managedEnvironment.appliedBase) {
		if (managedEnvironment.previousBase === undefined) delete process.env.WL_SESSION_BASE;
		else process.env.WL_SESSION_BASE = managedEnvironment.previousBase;
	}
	if (process.env.WL_SESSION_IDLE_TTL === managedEnvironment.appliedIdleTtl) {
		if (managedEnvironment.previousIdleTtl === undefined) delete process.env.WL_SESSION_IDLE_TTL;
		else process.env.WL_SESSION_IDLE_TTL = managedEnvironment.previousIdleTtl;
	}
	managedEnvironment = undefined;
}

export default function wolframSessionsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		configureEnvironment(ctx);

		if (wlSessionScript && sessionBase) {
			await runWlSession(pi, sessionBase, ["gc"]);
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus("wolfram-sessions", `WL sessions: ${sessionId?.slice(0, 8) ?? "scoped"}`);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const base = sessionBase;
		let result: Awaited<ReturnType<typeof runWlSession>> | undefined;
		try {
			if (base && wlSessionScript) result = await runWlSession(pi, base, ["stop-all"]);
		} finally {
			restoreEnvironment();
			sessionBase = undefined;
			sessionId = undefined;
			wlSessionScript = undefined;
			if (ctx.hasUI) ctx.ui.setStatus("wolfram-sessions", undefined);
		}

		if (ctx.hasUI && result && result.code !== 0) {
			ctx.ui.notify(`Could not stop Wolfram sessions: ${result.stderr || result.stdout}`, "warning");
		}
	});

	pi.registerCommand("wolfram-sessions", {
		description: "List/stop Mathematica sessions scoped to this pi session",
		handler: async (args, ctx) => {
			if (!sessionBase) configureEnvironment(ctx);
			const base = sessionBase!;

			const [action = "list", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const wlArgs =
				action === "stop" || action === "stop-all"
					? ["stop-all"]
					: action === "gc"
						? ["gc"]
						: action === "base"
							? []
							: ["list", ...rest];

			if (action === "base") {
				if (ctx.hasUI) ctx.ui.notify(base, "info");
				return;
			}

			const result = await runWlSession(pi, base, wlArgs);
			const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
			if (ctx.hasUI) ctx.ui.notify(text || "No Wolfram sessions", result.code === 0 ? "info" : "warning");
		},
	});
}
