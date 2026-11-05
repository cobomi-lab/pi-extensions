/**
 * Model autodiscovery for OpenAI-compatible providers.
 *
 * Package: pi-model-scout (see README.md)
 *
 * For every provider in ~/.pi/agent/models.json with `"discoverModels": true`,
 * fetches GET {baseUrl}/models and registers the returned models.
 * baseUrl, apiKey, api, headers and compat are taken from models.json.
 *
 * Unsloth Studio: connected external services (OpenRouter, OpenAI, ...) from
 * GET {root}/api/providers/ are registered as extra providers named
 * "<provider>-<service>" (e.g. unsloth-openrouter). Requests go through Unsloth's
 * /v1/chat/completions with `provider_id` + `external_model`, so Unsloth's stored
 * service key is used.
 *
 * Command: /scout-refresh re-reads models.json and re-runs discovery, picking up
 * new providers, new models, and new Unsloth connected services.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

interface ProviderEntry {
	baseUrl: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	discoverModels?: boolean;
	contextWindow?: number; // optional default for discovered models
	maxTokens?: number;
}

const MODELS_JSON = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json");
const REQUEST_TIMEOUT_MS = 2000;
const LOG_PREFIX = "[pi-model-scout]";

/** Same syntax as models.json: $VAR, ${VAR}, !command, or literal. */
function resolveValue(value?: string): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) return execSync(value.slice(1), { encoding: "utf8" }).trim();
	return value.replace(/\$\$|\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => (m === "$$" ? "$" : (process.env[a ?? b] ?? "")));
}

async function getJson(cfg: ProviderEntry, url: string, signal?: AbortSignal): Promise<any> {
	const key = resolveValue(cfg.apiKey);
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = resolveValue(v) ?? "";
	if (key) headers.Authorization = `Bearer ${key}`;

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	} catch (err) {
		if (timeout.aborted) throw new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${url})`);
		throw err;
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.json();
}

const trim = (url: string) => url.replace(/\/+$/, "");

async function discover(cfg: ProviderEntry, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const body = (await getJson(cfg, `${trim(cfg.baseUrl)}/models`, signal)) as { data?: Record<string, any>[] };
	return (body.data ?? []).map((m) => ({
		id: m.id,
		name: m.display_name ?? m.name ?? m.id,
		reasoning: /reason|thinking|qwen3|r1|gpt-oss/i.test(m.id),
		input: /gemma|vl|vision|ministral|llava/i.test(m.id) ? ["text", "image"] : ["text"],
		contextWindow: m.context_length ?? m.max_model_len ?? cfg.contextWindow ?? 32768,
		maxTokens: cfg.maxTokens ?? 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(cfg.compat ? { compat: cfg.compat } : {}),
	}));
}

interface UnslothConnection {
	id: string;
	provider_type: string;
	display_name: string;
	is_enabled: boolean;
	models: string[];
	max_output_tokens: number | null;
}

/** Unsloth Studio connected services. Returns [] for non-Unsloth servers. */
async function discoverUnslothConnections(cfg: ProviderEntry, signal?: AbortSignal) {
	const root = trim(cfg.baseUrl).replace(/\/v1$/, "");
	let list: unknown;
	try {
		list = await getJson(cfg, `${root}/api/providers/`, signal);
	} catch {
		return [];
	}
	if (!Array.isArray(list)) return [];
	return (list as UnslothConnection[])
		.filter((c) => c.is_enabled && c.models?.length)
		.map((c) => ({
			connection: c,
			models: c.models.map(
				(id): ProviderModelConfig => ({
					id,
					name: `${id} (${c.display_name} via Unsloth)`,
					reasoning: /reason|thinking|r1|o\d|gpt-5|claude|gemini-2\.5|gemini-3|grok-4|qwen3/i.test(id),
					input: /gpt-4o|claude|gemini|grok|vision|vl/i.test(id) ? ["text", "image"] : ["text"],
					contextWindow: cfg.contextWindow ?? 128000,
					maxTokens: c.max_output_tokens ?? cfg.maxTokens ?? 8192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					// Extra body fields that make Unsloth route to the connected service.
					samplingParams: { provider_id: c.id, provider_type: c.provider_type, external_model: id },
					...(cfg.compat ? { compat: cfg.compat } : {}),
				}),
			),
		}));
}

/** Reads providers from models.json. A missing file means no providers; a broken file is an error. */
function readProviders(): Record<string, ProviderEntry> {
	let text: string;
	try {
		text = readFileSync(MODELS_JSON, "utf8");
	} catch {
		return {};
	}
	try {
		return JSON.parse(text).providers ?? {};
	} catch (err) {
		throw new Error(`cannot parse ${MODELS_JSON}: ${(err as Error).message}`);
	}
}

interface SyncResult {
	providers: { name: string; models: number }[];
	errors: string[];
	/** False when models.json could not be parsed; nothing was changed. */
	configOk: boolean;
}

export default async function (pi: ExtensionAPI) {
	/** Provider names registered by this extension, so stale ones can be removed on refresh. */
	let registered = new Set<string>();

	/** Reads models.json, discovers models, and (re-)registers every provider. */
	async function sync(signal?: AbortSignal): Promise<SyncResult> {
		const result: SyncResult = { providers: [], errors: [], configOk: true };
		let providers: Record<string, ProviderEntry>;
		try {
			providers = readProviders();
		} catch (err) {
			result.errors.push((err as Error).message);
			result.configOk = false;
			return result;
		}

		const next = new Set<string>();
		await Promise.all(
			Object.entries(providers)
				.filter(([, cfg]) => cfg.discoverModels && cfg.baseUrl)
				.map(async ([id, cfg]) => {
					let models: ProviderModelConfig[] = [];
					let reachable = true;
					try {
						models = await discover(cfg, signal);
					} catch (err) {
						reachable = false;
						result.errors.push(`${id}: ${(err as Error).message}`);
					}
					pi.registerProvider(id, {
						baseUrl: cfg.baseUrl,
						apiKey: cfg.apiKey,
						api: (cfg.api ?? "openai-completions") as any,
						headers: cfg.headers,
						models,
						async refreshModels(ctx) {
							if (!ctx.allowNetwork) return models;
							models = await discover(cfg, ctx.signal);
							return models;
						},
					});
					next.add(id);
					result.providers.push({ name: id, models: models.length });

					// Skip the Unsloth probe when the server is down, so startup waits for one timeout, not two.
					const connections = reachable ? await discoverUnslothConnections(cfg, signal) : [];
					for (const { connection, models: extModels } of connections) {
						const name = `${id}-${connection.provider_type}`;
						let current = extModels;
						pi.registerProvider(name, {
							name: `${connection.display_name} (via ${id})`,
							baseUrl: cfg.baseUrl,
							apiKey: cfg.apiKey,
							api: (cfg.api ?? "openai-completions") as any,
							headers: cfg.headers,
							models: current,
							async refreshModels(ctx) {
								if (!ctx.allowNetwork) return current;
								const found = (await discoverUnslothConnections(cfg, ctx.signal)).find(
									(c) => c.connection.id === connection.id,
								);
								current = found?.models ?? [];
								return current;
							},
						});
						next.add(name);
						result.providers.push({ name, models: current.length });
					}
				}),
		);

		// Remove providers that are no longer configured or no longer offered by Unsloth.
		for (const name of registered) if (!next.has(name)) pi.unregisterProvider(name);
		registered = next;

		result.providers.sort((a, b) => a.name.localeCompare(b.name));
		return result;
	}

	/** Shows errors through pi's notifications, or on stderr when there is no UI. */
	function reportErrors(ctx: ExtensionContext, errors: string[]) {
		if (!errors.length) return;
		const message = `Model discovery failed:\n${errors.map((e) => `• ${e}`).join("\n")}`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.error(`${LOG_PREFIX} ${message}`);
	}

	// Initial discovery. Errors are kept until a session (and its UI) exists.
	let pendingErrors = (await sync()).errors;

	pi.on("session_start", (_event, ctx) => {
		reportErrors(ctx, pendingErrors);
		pendingErrors = [];
	});

	pi.registerCommand("scout-refresh", {
		description: "Re-read models.json and re-discover models from OpenAI-compatible endpoints",
		handler: async (_args, ctx) => {
			const { providers, errors, configOk } = await sync();
			reportErrors(ctx, errors);
			if (!configOk) return; // already reported; previously registered providers are kept
			const summary = providers.length
				? providers.map((p) => `${p.name}: ${p.models} model${p.models === 1 ? "" : "s"}`).join("\n")
				: `No providers with "discoverModels": true in ${MODELS_JSON}`;
			ctx.ui.notify(`Model discovery refreshed\n${summary}`, errors.length ? "warning" : "info");
		},
	});
}
