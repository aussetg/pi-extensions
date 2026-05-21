import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FALLBACK_RULES: Record<string, string[]> = {
	openai: ["openai-codex"],
	opencode: ["zai", "openai-codex"],
};

type Model = {
	id: string;
	provider: string;
	name?: string;
	api?: string;
	baseUrl?: string;
};

const PROVIDER_API_KEY_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	opencode: "OPENCODE_API_KEY",
};

function findRedirectTarget(models: Model[], model: Model): Model | undefined {
	const targetProviders = FALLBACK_RULES[model.provider];
	if (!targetProviders) return undefined;

	return targetProviders
		.map((provider) => models.find((candidate) => candidate.provider === provider && candidate.id === model.id))
		.find((candidate) => candidate !== undefined);
}

function shouldShadow(models: Model[], model: Model): boolean {
	return findRedirectTarget(models, model) !== undefined;
}

function visibleModels(models: Model[]): Model[] {
	return models.filter((model) => !shouldShadow(models, model));
}

function readAuthKey(provider: string): string | undefined {
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
		const key = auth[provider]?.key;
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

function providerApiKey(provider: string): string {
	return readAuthKey(provider) ?? PROVIDER_API_KEY_ENV[provider];
}

function shadowRedirectedModels(pi: ExtensionAPI, models: Model[], provider: string) {
	const providerModels = models.filter((model) => model.provider === provider);
	if (providerModels.length === 0) return;

	const visibleProviderModels = visibleModels(models).filter((model) => model.provider === provider);
	if (visibleProviderModels.length === providerModels.length) return;

	const firstModel = providerModels[0];
	pi.registerProvider(provider, {
		baseUrl: firstModel.baseUrl,
		api: firstModel.api as never,
		apiKey: providerApiKey(provider),
		models: visibleProviderModels.map(({ provider: _provider, ...model }) => model),
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const models = ctx.modelRegistry.getAvailable() as Model[];
		for (const provider of Object.keys(FALLBACK_RULES)) {
			shadowRedirectedModels(pi, models, provider);
		}
	});

	pi.on("model_select", async (event, ctx) => {
		const selected = event.model;
		const allModels = ctx.modelRegistry.getAvailable() as Model[];

		const targetModel = findRedirectTarget(allModels, selected);
		if (!targetModel) return;

		const switched = await pi.setModel(targetModel as never);
		if (!ctx.hasUI) return;

		if (switched) {
			ctx.ui.notify(
				`Auto-switched ${selected.provider}/${selected.id} → ${targetModel.provider}/${targetModel.id}`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`Could not auto-switch to ${targetModel.provider}/${targetModel.id}: no auth available`,
				"error",
			);
		}
	});
}