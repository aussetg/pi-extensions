import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_IDLE_TTL_SECONDS = "3600";

let sessionBase: string | undefined;
let sessionId: string | undefined;
let wlSessionScript: string | undefined;

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
	const root = process.env.WL_PI_SESSION_BASE_ROOT ?? path.join(os.tmpdir(), "pi-wolfram-sessions");
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

	return await pi.exec("bash", ["-lc", command], { timeout: 20_000 });
}

function configureEnvironment(ctx: ExtensionContext) {
	sessionId = getPiSessionId(ctx);
	sessionBase = getSessionBase(ctx);
	wlSessionScript = findWlSessionScript(ctx);

	fs.mkdirSync(sessionBase, { recursive: true });
	process.env.WL_SESSION_BASE = sessionBase;
	process.env.WL_SESSION_IDLE_TTL ??= DEFAULT_IDLE_TTL_SECONDS;
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
		if (!base || !wlSessionScript) return;

		const result = await runWlSession(pi, base, ["stop-all"]);
		if (ctx.hasUI) {
			ctx.ui.setStatus("wolfram-sessions", undefined);
			if (result.code !== 0) {
				ctx.ui.notify(`Could not stop Wolfram sessions: ${result.stderr || result.stdout}`, "warning");
			}
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
