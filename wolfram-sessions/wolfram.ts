import { CONFIG_DIR_NAME, type ExecResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || "unknown";
}

function getPiSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function getSessionBase(sessionId: string): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	const defaultRoot = path.join(runtimeDir && path.isAbsolute(runtimeDir) ? runtimeDir : os.tmpdir(), "pi-wolfram-sessions");
	const root = process.env.WL_PI_SESSION_BASE_ROOT ?? defaultRoot;
	return path.join(root, `pi-${sanitize(sessionId)}`);
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function isExecutableFile(candidate: string): boolean {
	try {
		if (!fs.statSync(candidate).isFile()) return false;
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findWlSessionScript(ctx: ExtensionContext): string | undefined {
	const candidates = [
		process.env.WOLFRAM_SESSION_SCRIPT,
		path.join(agentDir(), "skills", "wolfram-mathematica", "scripts", "wl-session"),
		path.join(os.homedir(), ".agents", "skills", "wolfram-mathematica", "scripts", "wl-session"),
	].filter((candidate): candidate is string => Boolean(candidate));

	if (ctx.isProjectTrusted()) {
		candidates.push(
			path.join(ctx.cwd, CONFIG_DIR_NAME, "skills", "wolfram-mathematica", "scripts", "wl-session"),
			path.join(ctx.cwd, ".agents", "skills", "wolfram-mathematica", "scripts", "wl-session"),
		);
	}

	return candidates.find(isExecutableFile);
}

function runWlSession(pi: ExtensionAPI, base: string, args: string[]): Promise<ExecResult> {
	if (!wlSessionScript) {
		return Promise.resolve({ stdout: "", stderr: "wl-session script not found", code: 127, killed: false });
	}

	const ttl = managedEnvironment?.appliedIdleTtl ?? process.env.WL_SESSION_IDLE_TTL ?? DEFAULT_IDLE_TTL_SECONDS;
	return pi.exec(
		"/usr/bin/env",
		["--", `WL_SESSION_BASE=${base}`, `WL_SESSION_IDLE_TTL=${ttl}`, wlSessionScript, ...args],
		{ timeout: commandTimeoutMs(base, args) },
	);
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
	const nextSessionBase = getSessionBase(nextSessionId);
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

async function removeSessionArtifacts(base: string): Promise<string | undefined> {
	try {
		await fs.promises.rm(base, { recursive: true, force: true });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
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
		const script = wlSessionScript;
		let result: Awaited<ReturnType<typeof runWlSession>> | undefined;
		let cleanupError: string | undefined;
		try {
			if (base && script) result = await runWlSession(pi, base, ["stop-all"]);
		} finally {
			if (base && (!script || result?.code === 0)) cleanupError = await removeSessionArtifacts(base);
			restoreEnvironment();
			sessionBase = undefined;
			sessionId = undefined;
			wlSessionScript = undefined;
			if (ctx.hasUI) ctx.ui.setStatus("wolfram-sessions", undefined);
		}

		if (ctx.hasUI && result && result.code !== 0) {
			ctx.ui.notify(`Could not stop Wolfram sessions: ${result.stderr || result.stdout}`, "warning");
		} else if (ctx.hasUI && cleanupError) {
			ctx.ui.notify(`Could not remove Wolfram session artifacts: ${cleanupError}`, "warning");
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
