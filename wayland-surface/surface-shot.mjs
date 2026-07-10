#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const runtimeDir = process.env.PI_WAYLAND_SURFACE_RUNTIME_DIR || process.env.XDG_RUNTIME_DIR || os.tmpdir();
const socketPath = process.env.PI_WAYLAND_SURFACE_SOCKET || path.join(runtimeDir, "pi-wayland-surface", "shot.sock");

const args = process.argv.slice(2);
const action = args[0] === "--status" ? "status" : args[0] === "--stop" ? "stop" : "shot";
const prompt = action === "shot" ? args.join(" ").trim() : "";
const request = JSON.stringify({ action, prompt }) + "\n";

const socket = net.createConnection(socketPath);
let reply = "";

function notify(summary, body = "", urgency = "normal") {
	if (process.env.PI_WAYLAND_SURFACE_NOTIFY === "0") return;
	if (process.stdout.isTTY && process.env.PI_WAYLAND_SURFACE_NOTIFY !== "1") return;

	const child = spawn("notify-send", ["--app-name=pi", "--urgency", urgency, summary, body], {
		detached: true,
		stdio: "ignore",
	});
	child.on("error", () => {});
	child.unref();
}

socket.setEncoding("utf8");
socket.on("connect", () => {
	socket.end(request);
});
socket.on("data", (chunk) => {
	reply += chunk;
});
socket.on("end", () => {
	const text = reply.trim();
	if (!text) return;

	try {
		const payload = JSON.parse(text);
		if (!payload.ok) {
			console.error(payload.error || "surface-shot failed");
			notify("pi screenshot failed", payload.error || "surface-shot failed", "critical");
			process.exitCode = 1;
			return;
		}
		if (action === "status") console.log(JSON.stringify(payload.result, null, 2));
		else if (payload.result?.path) {
			console.log(`sent ${payload.result.path}`);
			notify("pi screenshot sent", payload.result.path);
		} else {
			console.log("ok");
			notify("pi surface command ok");
		}
	} catch {
		console.log(text);
	}
});
socket.on("error", (error) => {
	console.error(`surface-shot: ${error.message}`);
	console.error("Is pi running, the extension reloaded, and /surface-share already active?");
	notify("pi screenshot failed", error.message, "critical");
	process.exit(1);
});
