import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";

type AnyFn = (...args: any[]) => any;

type ProfilerConfig = {
	enabled: boolean;
	slowMs: number;
	measureCpu: boolean;
	maxSamples: number;
	maxDurationsPerLabel: number;
	logFile: string;
	reportFile: string;
	reportOnShutdown: boolean;
	statusLine: boolean;
	instrument: {
		events: boolean;
		tools: boolean;
		toolRenderers: boolean;
		commands: boolean;
		shortcuts: boolean;
		autocomplete: boolean;
		uiRenderers: boolean;
	};
};

type Stat = {
	key: string;
	kind: string;
	name: string;
	source: string;
	owner: string;
	count: number;
	errors: number;
	slow: number;
	totalMs: number;
	totalCpuMs: number;
	maxMs: number;
	minMs: number;
	durations: number[];
	durationCursor: number;
};

type SlowSample = {
	at: string;
	kind: string;
	name: string;
	source: string;
	owner: string;
	wallMs: number;
	cpuMs?: number;
	error?: string;
};

type CpuSample = {
	at: string;
	wallMs: number;
	cpuMs: number;
	cpuPercent: number;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const EXTENSIONS_DIR = join(AGENT_DIR, "extensions");
const CONFIG_PATH = join(AGENT_DIR, "profiler.json");
const PROFILER_FILE = "helpers/profiler.ts";
const WRAPPED = Symbol.for("helpers.profiler.wrapped");
const GLOBAL_PATCH = Symbol.for("helpers.profiler.map-set-patch");

const KNOWN_EVENTS = new Set([
	"resources_discover",
	"session_start",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_before_tree",
	"session_tree",
	"session_shutdown",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"tool_call",
	"tool_result",
	"context",
	"before_provider_request",
	"after_provider_response",
	"model_select",
	"thinking_level_select",
	"user_bash",
	"input",
]);

const DEFAULT_CONFIG: ProfilerConfig = {
	enabled: false,
	slowMs: 20,
	measureCpu: true,
	maxSamples: 500,
	maxDurationsPerLabel: 512,
	logFile: "profiler.jsonl",
	reportFile: "profiler-report.md",
	reportOnShutdown: true,
	statusLine: true,
	instrument: {
		events: true,
		tools: true,
		toolRenderers: true,
		commands: true,
		shortcuts: true,
		autocomplete: true,
		uiRenderers: true,
	},
};

function mergeConfig(value: any): ProfilerConfig {
	const input = value && typeof value === "object" ? value : {};
	return {
		...DEFAULT_CONFIG,
		...input,
		instrument: {
			...DEFAULT_CONFIG.instrument,
			...(input.instrument && typeof input.instrument === "object" ? input.instrument : {}),
		},
	};
}

function registerFlags(pi: any): void {
	pi.registerFlag?.("profile", {
		description: "Enable the pi extension profiler for this process.",
		type: "boolean",
		default: false,
	});
}

function getBooleanCliFlag(name: string): boolean | undefined {
	const positive = `--${name}`;
	const positivePrefix = `${positive}=`;
	const negative = `--no-${name}`;

	for (const arg of process.argv.slice(2)) {
		if (arg === "--") break;
		if (arg === positive) return true;
		if (arg === negative) return false;
		if (arg.startsWith(positivePrefix)) {
			return /^(1|true|yes|on)$/i.test(arg.slice(positivePrefix.length));
		}
	}

	return undefined;
}

function readConfig(pi: any): ProfilerConfig {
	let config = DEFAULT_CONFIG;
	if (existsSync(CONFIG_PATH)) {
		try {
			config = mergeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
		} catch (error) {
			console.error(`[profiler] Could not parse ${CONFIG_PATH}: ${formatError(error)}`);
		}
	}

	const env = process.env.PI_PROFILER;
	if (env != null && env !== "") {
		config = { ...config, enabled: /^(1|true|yes|on)$/i.test(env) };
	}

	const cliProfile = getBooleanCliFlag("profile");
	if (cliProfile !== undefined) {
		config = { ...config, enabled: cliProfile };
	} else if (pi.getFlag?.("profile")) {
		config = { ...config, enabled: true };
	}

	return config;
}

function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (isAbsolute(path)) return path;
	return resolve(AGENT_DIR, path);
}

function ensureParent(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
	return !!value && (typeof value === "object" || typeof value === "function") && typeof (value as any).then === "function";
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function pad(value: string, width: number): string {
	if (value.length > width) return value.slice(0, width - 1) + "…";
	return value + " ".repeat(width - value.length);
}

function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[index];
}

function normalizeSource(path: string | undefined): string {
	if (!path) return "unknown";
	let clean = path.replace(/^file:\/\//, "");
	clean = clean.replace(/:\d+:\d+$/, "");
	clean = clean.replace(/:\d+$/, "");

	if (clean.startsWith(EXTENSIONS_DIR)) {
		return relative(EXTENSIONS_DIR, clean) || clean;
	}
	return clean;
}

function ownerFromSource(source: string): string {
	if (!source || source === "unknown") return "unknown";
	const first = source.split(/[\\/]/)[0];
	return first || source;
}

function captureSource(): string {
	const stack = new Error().stack?.split("\n").slice(2) ?? [];
	let fallback: string | undefined;

	for (const line of stack) {
		const match = line.match(/\((file:\/\/[^)]+|\/[^)]+):\d+:\d+\)/) ?? line.match(/at (file:\/\/\S+|\/\S+):\d+:\d+/);
		if (!match) continue;
		const path = match[1].replace(/^file:\/\//, "");
		if (path.includes(PROFILER_FILE)) continue;
		if (path.includes("node:internal")) continue;
		if (path.includes("/node_modules/jiti/")) continue;
		if (path.includes("/node_modules/@earendil-works/")) continue;
		if (path.includes("/node_modules/@mariozechner/")) continue;
		if (path.startsWith(EXTENSIONS_DIR)) return normalizeSource(path);
		fallback ??= normalizeSource(path);
	}

	return fallback ?? "unknown";
}

function sourceFromInfo(sourceInfo: any): string | undefined {
	if (!sourceInfo || typeof sourceInfo !== "object") return undefined;
	for (const key of ["path", "source", "baseDir"]) {
		const value = sourceInfo[key];
		if (typeof value === "string" && value.length > 0) return normalizeSource(value);
	}
	return undefined;
}

function isProfilerSource(source: string | undefined): boolean {
	return !!source && source.includes(PROFILER_FILE);
}

export default function (pi: any) {
	registerFlags(pi);
	const config = readConfig(pi);
	if (!config.enabled) return;

	const startedAt = Date.now();
	const stats = new Map<string, Stat>();
	let slowSamples: SlowSample[] = [];
	let slowCursor = 0;
	let cpuSamples: CpuSample[] = [];
	let cpuCursor = 0;
	let lastCpu = process.cpuUsage();
	let lastCpuWall = performance.now();

	const logFile = expandPath(config.logFile);
	const reportFile = expandPath(config.reportFile);

	const cpuTimer = setInterval(() => {
		const now = performance.now();
		const cpu = process.cpuUsage(lastCpu);
		const wallMs = now - lastCpuWall;
		const cpuMs = (cpu.user + cpu.system) / 1000;
		const sample: CpuSample = {
			at: new Date().toISOString(),
			wallMs: round(wallMs),
			cpuMs: round(cpuMs),
			cpuPercent: round((cpuMs / Math.max(1, wallMs)) * 100),
		};

		const limit = Math.max(1, config.maxSamples | 0);
		if (cpuSamples.length < limit) {
			cpuSamples.push(sample);
		} else {
			cpuSamples[cpuCursor % limit] = sample;
			cpuCursor++;
		}

		lastCpu = process.cpuUsage();
		lastCpuWall = now;
	}, 1000);
	(cpuTimer as any).unref?.();

	function getStat(kind: string, name: string, source: string): Stat {
		const normalizedSource = normalizeSource(source);
		const key = `${kind}\t${name}\t${normalizedSource}`;
		let stat = stats.get(key);
		if (!stat) {
			stat = {
				key,
				kind,
				name,
				source: normalizedSource,
				owner: ownerFromSource(normalizedSource),
				count: 0,
				errors: 0,
				slow: 0,
				totalMs: 0,
				totalCpuMs: 0,
				maxMs: 0,
				minMs: Number.POSITIVE_INFINITY,
				durations: [],
				durationCursor: 0,
			};
			stats.set(key, stat);
		}
		return stat;
	}

	function pushDuration(stat: Stat, wallMs: number): void {
		const limit = Math.max(16, config.maxDurationsPerLabel | 0);
		if (stat.durations.length < limit) {
			stat.durations.push(wallMs);
			return;
		}
		stat.durations[stat.durationCursor % limit] = wallMs;
		stat.durationCursor++;
	}

	function record(kind: string, name: string, source: string, wallMs: number, cpuMs: number | undefined, error?: unknown): void {
		const stat = getStat(kind, name, source);
		stat.count++;
		stat.totalMs += wallMs;
		if (cpuMs != null) stat.totalCpuMs += cpuMs;
		stat.maxMs = Math.max(stat.maxMs, wallMs);
		stat.minMs = Math.min(stat.minMs, wallMs);
		if (error) stat.errors++;
		if (wallMs >= config.slowMs) stat.slow++;
		pushDuration(stat, wallMs);

		if (wallMs >= config.slowMs || error) {
			const sample: SlowSample = {
				at: new Date().toISOString(),
				kind,
				name,
				source: stat.source,
				owner: stat.owner,
				wallMs: round(wallMs),
			};
			if (cpuMs != null) sample.cpuMs = round(cpuMs);
			if (error) sample.error = formatError(error);

			const limit = Math.max(1, config.maxSamples | 0);
			if (slowSamples.length < limit) {
				slowSamples.push(sample);
			} else {
				slowSamples[slowCursor % limit] = sample;
				slowCursor++;
			}
		}
	}

	function measure(kind: string, name: string, source: string, fn: AnyFn, thisArg: any, args: any[]): any {
		const start = performance.now();
		const cpuStart = config.measureCpu ? process.cpuUsage() : undefined;

		const finish = (error?: unknown) => {
			const wallMs = performance.now() - start;
			const cpu = cpuStart ? process.cpuUsage(cpuStart) : undefined;
			const cpuMs = cpu ? (cpu.user + cpu.system) / 1000 : undefined;
			record(kind, name, source, wallMs, cpuMs, error);
		};

		try {
			const result = Reflect.apply(fn, thisArg, args);
			if (isPromiseLike(result)) {
				return result.then(
					(value: unknown) => {
						finish();
						return value;
					},
					(error: unknown) => {
						finish(error);
						throw error;
					},
				);
			}
			finish();
			return result;
		} catch (error) {
			finish(error);
			throw error;
		}
	}

	function wrap(kind: string, name: string, source: string, fn: AnyFn | undefined): AnyFn | undefined {
		if (typeof fn !== "function") return fn;
		if ((fn as any)[WRAPPED]) return fn;
		const wrapped = function profiled(this: any, ...args: any[]) {
			return measure(kind, name, source, fn, this, args);
		};
		Object.defineProperty(wrapped, WRAPPED, { value: true });
		return wrapped;
	}

	function withPatchedUi(ctx: any, source: string, fn: AnyFn, thisArg: any, args: any[]): any {
		const ui = ctx?.ui;
		if (!ui) return Reflect.apply(fn, thisArg, args);

		const restore: Array<() => void> = [];

		if (config.instrument.autocomplete && typeof ui.addAutocompleteProvider === "function") {
			const original = ui.addAutocompleteProvider;
			ui.addAutocompleteProvider = function profiledAddAutocompleteProvider(factory: AnyFn) {
				const wrappedFactory = function profiledAutocompleteFactory(this: any, current: any) {
					const provider = measure("autocomplete.factory", "addAutocompleteProvider", source, factory, this, [current]);
					if (!provider || typeof provider !== "object") return provider;
					return {
						...provider,
						getSuggestions: wrap("autocomplete.getSuggestions", "getSuggestions", source, provider.getSuggestions),
						applyCompletion: wrap("autocomplete.applyCompletion", "applyCompletion", source, provider.applyCompletion),
						shouldTriggerFileCompletion: wrap(
							"autocomplete.shouldTriggerFileCompletion",
							"shouldTriggerFileCompletion",
							source,
							provider.shouldTriggerFileCompletion,
						),
					};
				};
				return Reflect.apply(original, this, [wrappedFactory]);
			};
			restore.push(() => {
				ui.addAutocompleteProvider = original;
			});
		}

		if (config.instrument.uiRenderers && typeof ui.setFooter === "function") {
			const original = ui.setFooter;
			ui.setFooter = function profiledSetFooter(factory: any) {
				if (typeof factory !== "function") return Reflect.apply(original, this, [factory]);
				const wrappedFactory = function profiledFooterFactory(this: any, ...factoryArgs: any[]) {
					const footer = measure("ui.footer.factory", "setFooter", source, factory, this, factoryArgs);
					if (footer && typeof footer === "object" && typeof footer.render === "function") {
						return {
							...footer,
							render: wrap("ui.footer.render", "footer.render", source, footer.render),
						};
					}
					return footer;
				};
				return Reflect.apply(original, this, [wrappedFactory]);
			};
			restore.push(() => {
				ui.setFooter = original;
			});
		}

		if (config.instrument.uiRenderers && typeof ui.setWidget === "function") {
			const original = ui.setWidget;
			ui.setWidget = function profiledSetWidget(key: string, widget: any, options: any) {
				if (typeof widget !== "function") return Reflect.apply(original, this, [key, widget, options]);
				const wrappedWidget = function profiledWidgetFactory(this: any, ...widgetArgs: any[]) {
					const component = measure("ui.widget.factory", `setWidget:${key}`, source, widget, this, widgetArgs);
					if (component && typeof component === "object" && typeof component.render === "function") {
						component.render = wrap("ui.widget.render", `widget.render:${key}`, source, component.render) as AnyFn;
					}
					return component;
				};
				return Reflect.apply(original, this, [key, wrappedWidget, options]);
			};
			restore.push(() => {
				ui.setWidget = original;
			});
		}

		let result: any;
		try {
			result = Reflect.apply(fn, thisArg, args);
		} catch (error) {
			for (const restoreOne of restore.reverse()) restoreOne();
			throw error;
		}

		if (isPromiseLike(result)) {
			return result.finally(() => {
				for (const restoreOne of restore.reverse()) restoreOne();
			});
		}

		for (const restoreOne of restore.reverse()) restoreOne();
		return result;
	}

	function wrapEventHandler(eventName: string, source: string, handler: AnyFn): AnyFn {
		if ((handler as any)[WRAPPED]) return handler;
		const wrapped = function profiledEventHandler(this: any, event: any, ctx: any) {
			return measure(
				"event",
				eventName,
				source,
				function invoke(this: any) {
					return withPatchedUi(ctx, source, handler, this, [event, ctx]);
				},
				this,
				[],
			);
		};
		Object.defineProperty(wrapped, WRAPPED, { value: true });
		return wrapped;
	}

	function instrumentRegisteredValue(key: any, value: any): any {
		if (typeof key !== "string") return value;

		if (config.instrument.events && KNOWN_EVENTS.has(key) && Array.isArray(value) && value.every((item) => typeof item === "function")) {
			const source = captureSource();
			if (isProfilerSource(source)) return value;
			return value.map((handler) => wrapEventHandler(key, source, handler));
		}

		if (config.instrument.tools && value?.definition && typeof value.definition === "object" && value.definition.name === key) {
			const source = sourceFromInfo(value.sourceInfo) ?? captureSource();
			if (isProfilerSource(source)) return value;
			const definition = value.definition;
			const wrappedDefinition = {
				...definition,
				execute: wrap("tool.execute", key, source, definition.execute),
			};
			if (config.instrument.toolRenderers) {
				wrappedDefinition.renderCall = wrap("tool.renderCall", key, source, definition.renderCall);
				wrappedDefinition.renderResult = wrap("tool.renderResult", key, source, definition.renderResult);
			}
			return { ...value, definition: wrappedDefinition };
		}

		const looksLikeCommand =
			value?.sourceInfo &&
			value.name === key &&
			(typeof value.handler === "function" || typeof value.getArgumentCompletions === "function");
		if (config.instrument.commands && looksLikeCommand) {
			const source = sourceFromInfo(value.sourceInfo) ?? captureSource();
			if (isProfilerSource(source)) return value;
			return {
				...value,
				handler: wrap("command.handler", key, source, value.handler),
				getArgumentCompletions: wrap("command.completions", key, source, value.getArgumentCompletions),
			};
		}

		if (config.instrument.shortcuts && value?.extensionPath && value.shortcut === key) {
			const source = normalizeSource(value.extensionPath) || captureSource();
			if (isProfilerSource(source)) return value;
			return {
				...value,
				handler: wrap("shortcut.handler", key, source, value.handler),
			};
		}

		return value;
	}

	function installGlobalMapPatch(): () => void {
		type PatchState = {
			originalSet: typeof Map.prototype.set;
			current?: (key: any, value: any) => any;
		};

		const root = globalThis as any;
		let state = root[GLOBAL_PATCH] as PatchState | undefined;
		if (!state) {
			state = { originalSet: Map.prototype.set };
			root[GLOBAL_PATCH] = state;
			Map.prototype.set = function patchedMapSet(this: Map<any, any>, key: any, value: any) {
				const current = state?.current;
				const next = current ? current(key, value) : value;
				return state!.originalSet.call(this, key, next);
			};
		}

		state.current = instrumentRegisteredValue;
		return () => {
			if (state?.current === instrumentRegisteredValue) state.current = undefined;
			if (!state?.current && Map.prototype.set !== state?.originalSet) {
				Map.prototype.set = state.originalSet;
				delete root[GLOBAL_PATCH];
			}
		};
	}

	const originalOn = typeof pi.on === "function" ? pi.on.bind(pi) : undefined;
	const originalRegisterTool = typeof pi.registerTool === "function" ? pi.registerTool.bind(pi) : undefined;
	const originalRegisterCommand = typeof pi.registerCommand === "function" ? pi.registerCommand.bind(pi) : undefined;
	const originalRegisterShortcut = typeof pi.registerShortcut === "function" ? pi.registerShortcut.bind(pi) : undefined;
	const cleanupGlobalMapPatch = installGlobalMapPatch();

	if (originalOn && config.instrument.events) {
		pi.on = function profiledOn(eventName: string, handler: AnyFn) {
			const source = captureSource();
			return originalOn(eventName, wrapEventHandler(eventName, source, handler));
		};
	}

	if (originalRegisterTool && config.instrument.tools) {
		pi.registerTool = function profiledRegisterTool(definition: any) {
			const source = captureSource();
			const name = String(definition?.name ?? "unknown");
			const wrapped = {
				...definition,
				execute: wrap("tool.execute", name, source, definition?.execute),
			};
			if (config.instrument.toolRenderers) {
				wrapped.renderCall = wrap("tool.renderCall", name, source, definition?.renderCall);
				wrapped.renderResult = wrap("tool.renderResult", name, source, definition?.renderResult);
			}
			return originalRegisterTool(wrapped);
		};
	}

	if (originalRegisterCommand && config.instrument.commands) {
		pi.registerCommand = function profiledRegisterCommand(name: string, options: any) {
			const source = captureSource();
			const wrapped = {
				...options,
				handler: wrap("command.handler", name, source, options?.handler),
				getArgumentCompletions: wrap("command.completions", name, source, options?.getArgumentCompletions),
			};
			return originalRegisterCommand(name, wrapped);
		};
	}

	if (originalRegisterShortcut && config.instrument.shortcuts) {
		pi.registerShortcut = function profiledRegisterShortcut(shortcut: string, options: any) {
			const source = captureSource();
			const wrapped = {
				...options,
				handler: wrap("shortcut.handler", shortcut, source, options?.handler),
			};
			return originalRegisterShortcut(shortcut, wrapped);
		};
	}

	function reset(): void {
		stats.clear();
		slowSamples = [];
		slowCursor = 0;
		cpuSamples = [];
		cpuCursor = 0;
		lastCpu = process.cpuUsage();
		lastCpuWall = performance.now();
	}

	function statSnapshot() {
		return [...stats.values()].map((stat) => ({
			kind: stat.kind,
			name: stat.name,
			source: stat.source,
			owner: stat.owner,
			count: stat.count,
			errors: stat.errors,
			slow: stat.slow,
			totalMs: round(stat.totalMs),
			totalCpuMs: round(stat.totalCpuMs),
			avgMs: round(stat.totalMs / Math.max(1, stat.count)),
			p50Ms: round(percentile(stat.durations, 0.5)),
			p95Ms: round(percentile(stat.durations, 0.95)),
			maxMs: round(stat.maxMs),
			minMs: round(stat.minMs === Number.POSITIVE_INFINITY ? 0 : stat.minMs),
		}));
	}

	function ownerSnapshot() {
		const owners = new Map<string, { owner: string; count: number; errors: number; slow: number; totalMs: number; totalCpuMs: number; maxMs: number }>();
		for (const stat of stats.values()) {
			let owner = owners.get(stat.owner);
			if (!owner) {
				owner = { owner: stat.owner, count: 0, errors: 0, slow: 0, totalMs: 0, totalCpuMs: 0, maxMs: 0 };
				owners.set(stat.owner, owner);
			}
			owner.count += stat.count;
			owner.errors += stat.errors;
			owner.slow += stat.slow;
			owner.totalMs += stat.totalMs;
			owner.totalCpuMs += stat.totalCpuMs;
			owner.maxMs = Math.max(owner.maxMs, stat.maxMs);
		}
		return [...owners.values()].map((owner) => ({
			...owner,
			totalMs: round(owner.totalMs),
			totalCpuMs: round(owner.totalCpuMs),
			avgMs: round(owner.totalMs / Math.max(1, owner.count)),
			maxMs: round(owner.maxMs),
		}));
	}

	function table(rows: string[][]): string[] {
		if (rows.length === 0) return ["(none)"];
		const widths = rows[0].map((_, column) => Math.min(42, Math.max(...rows.map((row) => row[column]?.length ?? 0))));
		return rows.map((row) => row.map((cell, column) => pad(cell ?? "", widths[column])).join("  "));
	}

	function buildReport(): string {
		const byOwner = ownerSnapshot().sort((a, b) => b.totalMs - a.totalMs);
		const byTotal = statSnapshot().sort((a, b) => b.totalMs - a.totalMs);
		const byMax = statSnapshot().sort((a, b) => b.maxMs - a.maxMs);
		const samples = [...slowSamples].sort((a, b) => b.wallMs - a.wallMs).slice(0, 25);
		const orderedCpuSamples = [...cpuSamples].sort((a, b) => a.at.localeCompare(b.at));
		const avgCpu = orderedCpuSamples.length === 0
			? 0
			: orderedCpuSamples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / orderedCpuSamples.length;
		const maxCpu = orderedCpuSamples.reduce((max, sample) => Math.max(max, sample.cpuPercent), 0);
		const instrumentedCpuMs = [...stats.values()].reduce((sum, stat) => sum + stat.totalCpuMs, 0);

		const lines: string[] = [];
		lines.push("# Pi profiler report");
		lines.push("");
		lines.push(`Generated: ${new Date().toISOString()}`);
		lines.push(`Profiler started: ${new Date(startedAt).toISOString()}`);
		lines.push(`Config: ${CONFIG_PATH}`);
		lines.push(`Slow threshold: ${config.slowMs}ms`);
		lines.push(`Process CPU avg/max while profiling: ${round(avgCpu)}% / ${round(maxCpu)}%`);
		lines.push(`Instrumented extension CPU total: ${round(instrumentedCpuMs)}ms`);
		lines.push("");

		lines.push("## Process CPU samples");
		lines.push("");
		lines.push(...table([
			["at", "cpu", "cpu ms", "wall ms"],
			...orderedCpuSamples.slice(-20).map((sample) => [
				sample.at,
				`${sample.cpuPercent}%`,
				`${sample.cpuMs}ms`,
				`${sample.wallMs}ms`,
			]),
		]));
		lines.push("");

		lines.push("## Top extension owners by total wall time");
		lines.push("");
		lines.push(...table([
			["owner", "calls", "total", "avg", "max", "slow", "errors"],
			...byOwner.slice(0, 30).map((row) => [
				row.owner,
				String(row.count),
				`${row.totalMs}ms`,
				`${row.avgMs}ms`,
				`${row.maxMs}ms`,
				String(row.slow),
				String(row.errors),
			]),
		]));
		lines.push("");

		lines.push("## Top labels by total wall time");
		lines.push("");
		lines.push(...table([
			["kind", "name", "source", "calls", "total", "p95", "max", "slow", "errors"],
			...byTotal.slice(0, 40).map((row) => [
				row.kind,
				row.name,
				row.source,
				String(row.count),
				`${row.totalMs}ms`,
				`${row.p95Ms}ms`,
				`${row.maxMs}ms`,
				String(row.slow),
				String(row.errors),
			]),
		]));
		lines.push("");

		lines.push("## Slowest individual calls");
		lines.push("");
		lines.push(...table([
			["wall", "cpu", "kind", "name", "source", "at", "error"],
			...samples.map((sample) => [
				`${sample.wallMs}ms`,
				sample.cpuMs == null ? "" : `${sample.cpuMs}ms`,
				sample.kind,
				sample.name,
				sample.source,
				sample.at,
				sample.error ?? "",
			]),
		]));
		lines.push("");

		lines.push("## Top labels by max wall time");
		lines.push("");
		lines.push(...table([
			["max", "p95", "kind", "name", "source", "calls", "total"],
			...byMax.slice(0, 25).map((row) => [
				`${row.maxMs}ms`,
				`${row.p95Ms}ms`,
				row.kind,
				row.name,
				row.source,
				String(row.count),
				`${row.totalMs}ms`,
			]),
		]));
		lines.push("");
		return `${lines.join("\n")}\n`;
	}

	function writeSnapshot(reason: string): { reportFile: string; logFile: string } {
		const report = buildReport();
		ensureParent(reportFile);
		writeFileSync(reportFile, report, "utf8");

		ensureParent(logFile);
		appendFileSync(logFile, `${JSON.stringify({
			type: "profiler-snapshot",
			reason,
			at: new Date().toISOString(),
			startedAt: new Date(startedAt).toISOString(),
			configPath: CONFIG_PATH,
			stats: statSnapshot(),
			owners: ownerSnapshot(),
			slowSamples,
			cpuSamples,
		})}\n`, "utf8");

		return { reportFile, logFile };
	}

	function writeConfig(next: ProfilerConfig): void {
		ensureParent(CONFIG_PATH);
		writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	}

	async function runJscProfile(seconds: number, intervalUs: number): Promise<{ textFile: string; jsonFile: string }> {
		const jsc = await import("bun:jsc");
		if (typeof (jsc as any).profile !== "function") {
			throw new Error("bun:jsc profile() is not available in this runtime");
		}

		const clampedSeconds = Math.max(1, Math.min(120, Math.round(seconds)));
		const clampedIntervalUs = Math.max(50, Math.min(100_000, Math.round(intervalUs)));
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const textFile = expandPath(`profiler-jsc-${stamp}.txt`);
		const jsonFile = expandPath(`profiler-jsc-${stamp}.json`);

		const result = await (jsc as any).profile(
			async function piProfilerJscSampleWindow() {
				await new Promise((resolve) => setTimeout(resolve, clampedSeconds * 1000));
			},
			clampedIntervalUs,
		);

		const stackTraces = Array.isArray(result?.stackTraces)
			? result.stackTraces.map((trace: unknown) => typeof trace === "string" ? trace : JSON.stringify(trace, null, 2)).join("\n\n")
			: JSON.stringify(result?.stackTraces, null, 2);

		const text = [
			"# Pi JavaScriptCore sampling profile",
			"",
			`Generated: ${new Date().toISOString()}`,
			`Duration: ${clampedSeconds}s`,
			`Sample interval: ${clampedIntervalUs}µs`,
			"",
			"## Top functions",
			"",
			String(result?.functions ?? ""),
			"",
			"## Top bytecodes",
			"",
			String(result?.bytecodes ?? ""),
			"",
			"## Stack traces",
			"",
			stackTraces,
			"",
		].join("\n");

		ensureParent(textFile);
		writeFileSync(textFile, text, "utf8");
		writeFileSync(jsonFile, JSON.stringify(result, null, 2), "utf8");
		return { textFile, jsonFile };
	}

	originalRegisterCommand?.("profiler", {
		description: "Write/reset pi extension profiler reports",
		handler: async (args: string, ctx: any) => {
			const tokens = (args || "report").trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] || "report";

			if (action === "reset") {
				reset();
				ctx.ui?.notify?.("profiler counters reset", "info");
				return;
			}

			if (action === "jsc") {
				const seconds = Number(tokens[1] ?? 10);
				const intervalUs = Number(tokens[2] ?? 1000);
				ctx.ui?.notify?.(`profiler JSC sampling for ${Number.isFinite(seconds) ? seconds : 10}s...`, "info");
				const paths = await runJscProfile(Number.isFinite(seconds) ? seconds : 10, Number.isFinite(intervalUs) ? intervalUs : 1000);
				ctx.ui?.notify?.(`profiler JSC profile written: ${paths.textFile}`, "info");
				return;
			}

			if (action === "disable") {
				writeConfig({ ...config, enabled: false });
				ctx.ui?.notify?.(`profiler disabled in ${CONFIG_PATH}; run /reload or restart pi`, "info");
				return;
			}

			if (action === "status") {
				ctx.ui?.notify?.(`profiler enabled · ${stats.size} labels · report ${reportFile}`, "info");
				return;
			}

			const paths = writeSnapshot("command");
			ctx.ui?.notify?.(`profiler report written: ${paths.reportFile}`, "info");
		},
	});

	originalOn?.("session_start", (_event: any, ctx: any) => {
		if (config.statusLine) ctx.ui?.setStatus?.("profiler", "profile:on");
	});

	originalOn?.("session_shutdown", () => {
		clearInterval(cpuTimer);
		if (config.reportOnShutdown) writeSnapshot("session_shutdown");
		cleanupGlobalMapPatch();
	});
}

