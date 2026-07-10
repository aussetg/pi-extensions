// @ts-nocheck
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

declare const process: {
	env: Record<string, string | undefined>;
	on?(event: string, handler: (...args: any[]) => void): void;
};

type JsonObject = Record<string, unknown>;

interface HelperReply {
	id: number;
	ok: boolean;
	result?: JsonObject;
	error?: string;
}

interface PendingRequest {
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ShareOptions {
	sourceTypes: number;
	cursorMode?: number;
	persistMode?: number;
}

interface CaptureResult extends JsonObject {
	path: string;
	bytes: number;
	width?: number;
	height?: number;
}

const HELPER_PATH = fileURLToPath(new URL("./portal-helper.py", import.meta.url));
const CLIENT_PATH = fileURLToPath(new URL("./surface-shot.mjs", import.meta.url));
const CACHE_DIR = join(tmpdir(), "pi-wayland-surface");
const IPC_DIR = join(process.env.PI_WAYLAND_SURFACE_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || tmpdir(), "pi-wayland-surface");
const IPC_SOCKET = process.env.PI_WAYLAND_SURFACE_SOCKET || join(IPC_DIR, "shot.sock");

class WaylandSurfaceHelper {
	private child: any | undefined;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private stdoutBuffer = "";
	private stderrTail = "";
	private sequence: Promise<unknown> = Promise.resolve();

	async start(options: ShareOptions): Promise<JsonObject> {
		return this.serialized(() => this.request("start", options, 5 * 60_000));
	}

	async status(): Promise<JsonObject> {
		return this.serialized(() => this.request("status", {}, 10_000));
	}

	async capture(outputPath: string): Promise<CaptureResult> {
		return this.serialized(() => this.request("capture", { path: outputPath }, 45_000) as Promise<CaptureResult>);
	}

	async stop(): Promise<JsonObject> {
		return this.serialized(() => this.request("stop", {}, 15_000));
	}

	async shutdown(): Promise<void> {
		if (!this.child) return;
		try {
			await this.request("shutdown", {}, 5_000);
		} catch {
			// The process may already be gone. Fall through and kill it below.
		}
		this.child?.kill("SIGTERM");
		this.child = undefined;
	}

	terminate() {
		this.child?.kill("SIGTERM");
		this.child = undefined;
	}

	private async serialized<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.sequence.then(fn, fn);
		this.sequence = run.catch(() => undefined);
		return run;
	}

	private request(method: string, params: JsonObject, timeoutMs: number): Promise<JsonObject> {
		this.ensureChild();
		const child = this.child;
		if (!child) throw new Error("Wayland surface helper did not start");

		const id = this.nextId++;
		const payload = JSON.stringify({ id, method, params }) + "\n";

		return new Promise<JsonObject>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(payload, (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	private ensureChild() {
		if (this.child && !this.child.killed) return;

		const python = process.env.PI_WAYLAND_SURFACE_PYTHON || process.env.PYTHON || "python";
		this.stdoutBuffer = "";
		this.stderrTail = "";
		const child = spawn(python, [HELPER_PATH], {
			stdio: "pipe",
			env: process.env as Record<string, string>,
		});
		this.child = child;

		child.on("error", (cause: Error) => {
			const action = child.pid ? "encountered a process error" : "failed to start";
			const suffix = this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : "";
			this.failChild(child, new Error(`Wayland surface helper ${action}: ${cause.message}${suffix}`));
		});

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		child.on("exit", (code, signal) => {
			const suffix = this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : "";
			const error = new Error(`Wayland surface helper exited (${signal ?? code ?? "unknown"}).${suffix}`);
			this.failChild(child, error);
		});
	}

	private failChild(child: any, error: Error) {
		// A failed child may still emit "exit" after "error". Ignore that stale
		// event, especially if a later request has already started a replacement.
		if (this.child !== child) return;
		this.child = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private onStdout(chunk: string) {
		this.stdoutBuffer += chunk;
		for (;;) {
			const index = this.stdoutBuffer.indexOf("\n");
			if (index < 0) return;
			const line = this.stdoutBuffer.slice(0, index).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
			if (!line) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string) {
		let reply: HelperReply;
		try {
			reply = JSON.parse(line) as HelperReply;
		} catch {
			this.stderrTail = (this.stderrTail + `\nnon-json helper output: ${line}`).slice(-4000);
			return;
		}

		const pending = this.pending.get(reply.id);
		if (!pending) return;
		this.pending.delete(reply.id);
		clearTimeout(pending.timer);

		if (reply.ok) pending.resolve(reply.result ?? {});
		else pending.reject(new Error(reply.error || "Wayland surface helper failed"));
	}
}

function parseShareOptions(args: string): ShareOptions {
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	let sourceTypes = 3; // monitor | window
	let cursorMode: number | undefined;
	let persistMode = 0;

	for (const word of words) {
		if (["monitor", "screen", "display"].includes(word)) sourceTypes = 1;
		else if (["window", "app"].includes(word)) sourceTypes = 2;
		else if (["any", "surface"].includes(word)) sourceTypes = 3;
		else if (["hidden", "no-cursor", "nocursor"].includes(word)) cursorMode = 1;
		else if (["cursor", "embedded"].includes(word)) cursorMode = 2;
		else if (word === "metadata") cursorMode = 4;
		else if (["remember", "persist"].includes(word)) persistMode = 2;
		else if (["session", "temporary", "temp"].includes(word)) persistMode = 0;
	}

	return { sourceTypes, cursorMode, persistMode };
}

function sourceLabel(sourceTypes: number): string {
	if (sourceTypes === 1) return "monitor";
	if (sourceTypes === 2) return "window";
	return "surface";
}

function screenshotPath(): string {
	return join(CACHE_DIR, `shot-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
}

function asImageContent(data: string) {
	return {
		type: "image",
		data,
		mimeType: "image/png",
	};
}

function sendScreenshot(pi: any, ctx: any, prompt: string, imagePath: string, followUp = false) {
	const data = readFileSync(imagePath).toString("base64");
	const content = [{ type: "text", text: prompt }, asImageContent(data)];
	if (followUp || ctx.isIdle?.() === false) pi.sendUserMessage(content as any, { deliverAs: "followUp" });
	else pi.sendUserMessage(content as any);
}

function captureSummary(result: CaptureResult): string {
	const size = result.width && result.height ? ` ${result.width}×${result.height}` : "";
	return `${result.path}${size}, ${result.bytes} bytes`;
}

function externalShortcutCommand(prompt = "Here is the current screenshot of the shared Wayland surface."): string {
	return `${CLIENT_PATH} ${JSON.stringify(prompt)}`;
}

function ipcHelpText(): string {
	return [
		"Wayland surface IPC is listening.",
		`socket: ${IPC_SOCKET}`,
		"",
		"Bind this command to a global desktop shortcut:",
		externalShortcutCommand(),
		"",
		"Run /surface-share once first. The shortcut can then be pressed from any focused application.",
	].join("\n");
}

class SurfaceIpcServer {
	private server: any | undefined;
	private ctx: any | undefined;
	private sockets = new Set<any>();

	constructor(private pi: any, private helper: WaylandSurfaceHelper) {}

	setContext(ctx: any) {
		this.ctx = ctx;
	}

	async start(ctx: any) {
		this.ctx = ctx;
		if (this.server) return;

		await mkdir(IPC_DIR, { recursive: true });
		try {
			unlinkSync(IPC_SOCKET);
		} catch (error) {
			if ((error as any)?.code !== "ENOENT") throw error;
		}

		// The client half-closes after sending its request; keep our writable side
		// open while the helper performs the asynchronous capture.
		const server = createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
		this.server = server;
		server.unref?.();

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.removeListener("listening", onListening);
				this.server = undefined;
				reject(error);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				try {
					chmodSync(IPC_SOCKET, 0o600);
				} catch {
					// Best effort only.
				}
				resolve();
			};

			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(IPC_SOCKET);
		});
	}

	stop() {
		const server = this.server;
		this.server = undefined;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		server?.close?.();
		try {
			unlinkSync(IPC_SOCKET);
		} catch {
			// Ignore stale/missing socket cleanup failures.
		}
	}

	private handleSocket(socket: any) {
		let raw = "";
		this.sockets.add(socket);
		socket.unref?.();
		socket.setEncoding("utf8");
		socket.on("close", () => {
			this.sockets.delete(socket);
		});
		socket.on("error", () => {
			// Client disappeared or sent garbage. Nothing to do.
		});
		socket.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 64 * 1024) socket.destroy(new Error("IPC request too large"));
		});
		socket.on("end", () => {
			void this.handleRequest(raw, socket);
		});
	}

	private async handleRequest(raw: string, socket: any) {
		try {
			const request = this.parseRequest(raw);
			const action = request.action || "shot";
			let result: JsonObject;

			if (action === "status") {
				result = { ...(await this.helper.status()), socket: IPC_SOCKET, command: externalShortcutCommand() };
			} else if (action === "stop") {
				result = await this.helper.stop();
			} else if (action === "shot" || action === "screenshot") {
				result = await this.captureAndSend(typeof request.prompt === "string" ? request.prompt : "");
			} else {
				throw new Error(`unknown IPC action: ${action}`);
			}

			socket.end(JSON.stringify({ ok: true, result }) + "\n");
		} catch (error) {
			socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
		}
	}

	private parseRequest(raw: string): JsonObject {
		const text = raw.trim();
		if (!text) return { action: "shot" };
		try {
			return JSON.parse(text) as JsonObject;
		} catch {
			return { action: "shot", prompt: text };
		}
	}

	private async captureAndSend(prompt: string): Promise<CaptureResult> {
		await mkdir(CACHE_DIR, { recursive: true });
		const result = await this.helper.capture(screenshotPath());
		sendScreenshot(
			this.pi,
			this.ctx ?? {},
			prompt.trim() || "Here is the current screenshot of the shared Wayland surface.",
			result.path,
			true,
		);
		return result;
	}
}

export default function waylandSurfaceExtension(pi: any) {
	const helper = new WaylandSurfaceHelper();
	const ipc = new SurfaceIpcServer(pi, helper);

	pi.registerCommand("surface-share", {
		description: "Pick a Wayland screen/window once via the portal",
		handler: async (args: string, ctx: any) => {
			ipc.setContext(ctx);
			ctx.ui.setStatus("surface", "sharing…");
			try {
				const options = parseShareOptions(args);
				const result = await helper.start(options);
				ctx.ui.notify(`Sharing ${sourceLabel(options.sourceTypes)}: ${result.streamLabel ?? "ready"}`, "info");
			} catch (error) {
				ctx.ui.notify(`surface-share failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("surface", undefined);
			}
		},
	});

	pi.registerCommand("surface-shot", {
		description: "Capture the shared Wayland surface and send it as an image message",
		handler: async (args: string, ctx: any) => {
			ipc.setContext(ctx);
			ctx.ui.setStatus("surface", "shot…");
			try {
				await mkdir(CACHE_DIR, { recursive: true });
				const outputPath = screenshotPath();
				const result = await helper.capture(outputPath);
				const prompt = args.trim() || "Here is the current screenshot of the shared Wayland surface.";
				sendScreenshot(pi, ctx, prompt, result.path);
				ctx.ui.notify(`Screenshot sent: ${captureSummary(result)}`, "info");
			} catch (error) {
				ctx.ui.notify(`surface-shot failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("surface", undefined);
			}
		},
	});

	pi.registerCommand("surface-status", {
		description: "Show Wayland surface sharing status",
		handler: async (_args: string, ctx: any) => {
			ipc.setContext(ctx);
			try {
				const status = await helper.status();
				const text = status.active
					? `Wayland surface active: ${status.streamLabel ?? "stream ready"}`
					: "Wayland surface helper is running, but no surface is shared.";
				pi.sendMessage({ customType: "surface-status", content: `${text}\n\n${ipcHelpText()}`, display: true, details: { ...status, socket: IPC_SOCKET } });
			} catch (error) {
				ctx.ui.notify(`surface-status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("surface-ipc", {
		description: "Show the external shortcut command for /surface-shot",
		handler: async (_args: string, ctx: any) => {
			ipc.setContext(ctx);
			pi.sendMessage({ customType: "surface-ipc", content: ipcHelpText(), display: true, details: { socket: IPC_SOCKET, command: externalShortcutCommand() } });
		},
	});

	pi.registerCommand("surface-stop", {
		description: "Stop the active Wayland screen/window share",
		handler: async (_args: string, ctx: any) => {
			ipc.setContext(ctx);
			try {
				await helper.stop();
				ctx.ui.notify("Wayland surface share stopped", "info");
			} catch (error) {
				ctx.ui.notify(`surface-stop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "surface_screenshot",
		label: "Surface Screenshot",
		description: "Capture the Wayland surface previously selected with /surface-share and queue it as a follow-up image message.",
		promptSnippet: "Capture the shared Wayland surface as a screenshot when the user asks to inspect the current GUI.",
		promptGuidelines: [
			"Use surface_screenshot only after the user has explicitly shared a Wayland surface with /surface-share.",
			"surface_screenshot queues the image as a follow-up user message; wait for that image before analyzing the screen.",
		],
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Text to attach to the screenshot message" },
			},
			additionalProperties: false,
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: any) {
			await mkdir(CACHE_DIR, { recursive: true });
			const outputPath = screenshotPath();
			const result = await helper.capture(outputPath);
			const prompt = typeof params.prompt === "string" && params.prompt.trim()
				? params.prompt.trim()
				: "Here is the current screenshot of the shared Wayland surface.";
			sendScreenshot(pi, ctx, prompt, result.path, true);
			return {
				content: [{ type: "text", text: `Queued screenshot follow-up: ${captureSummary(result)}` }],
				details: result,
			};
		},
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			await ipc.start(ctx);
		} catch (error) {
			ctx.ui.notify(`surface IPC failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		ipc.stop();
		await helper.shutdown();
	});

	process.on?.("exit", () => {
		ipc.stop();
		helper.terminate();
	});
}
