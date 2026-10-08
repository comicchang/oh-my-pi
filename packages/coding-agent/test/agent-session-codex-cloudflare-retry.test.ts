import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const CLOUDFLARE_403_HTML =
	"<!DOCTYPE html><html><head><title>Unable to load site</title></head><body><h1>Unable to load site</h1><p>Ray ID: test-cloudflare-ray</p></body></html>";

type ScriptedResponse = {
	stopReason: "error" | "stop";
	errorStatus?: number;
	errorMessage?: string;
	content?: AssistantMessage["content"];
};

function cloudflare403(content: AssistantMessage["content"] = []): ScriptedResponse {
	return {
		stopReason: "error",
		errorStatus: 403,
		errorMessage: CLOUDFLARE_403_HTML,
		content,
	};
}

function successfulResponse(text: string): ScriptedResponse {
	return {
		stopReason: "stop",
		content: [{ type: "text", text }],
	};
}

function createAssistantMessage(model: Model, response: ScriptedResponse): AssistantMessage {
	return {
		role: "assistant",
		content: [...(response.content ?? [])],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: response.stopReason,
		...(response.errorStatus === undefined ? {} : { errorStatus: response.errorStatus }),
		...(response.errorMessage === undefined ? {} : { errorMessage: response.errorMessage }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected trailing assistant message");
	return message as AssistantMessage;
}

describe("AgentSession Codex Cloudflare 403 one-shot retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-codex-cf403-test-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createHarness(options: {
		sessionSettings?: Parameters<typeof Settings.isolated>[0];
		agentId?: string;
		agentKind?: "main" | "sub";
		responses: ScriptedResponse[];
	}) {
		const model = getBundledModel("openai-codex", "gpt-6.1-sol");
		if (!model) throw new Error("Expected bundled openai-codex/gpt-6.1-sol model");

		authStorage.keys.setRuntime("openai-codex", "codex-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		let attemptCount = 0;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test prompt"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				attemptCount++;
				const response = options.responses[attemptCount - 1] ?? {
					stopReason: "error",
					errorStatus: 403,
					errorMessage: "Unexpected additional request",
					content: [],
				};
				const message = createAssistantMessage(requestedModel, response);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (response.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 100,
			...options.sessionSettings,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const newSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: options.agentId,
			agentKind: options.agentKind,
		});
		session = newSession;
		return { session: newSession, model, attempts: () => attemptCount };
	}

	it("keeps 403 terminal when retry.codexCloudflare403RetryOnce is default-off", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({ responses: [cloudflare403()] });
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(1);
		expect(retryStarts).toHaveLength(0);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "error", errorStatus: 403 });
	});

	it("retries once and recovers when enabled", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const { session: sess, attempts } = createHarness({
			sessionSettings: { "retry.enabled": true, "retry.codexCloudflare403RetryOnce": true },
			responses: [cloudflare403(), successfulResponse("recovered successfully")],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(2);
		expect(retryStarts).toHaveLength(1);
		expect(retryEnds).toHaveLength(1);
		expect(retryEnds[0].success).toBe(true);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "stop" });
	});

	it("settles visibly after the single retry also returns the Cloudflare 403", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const {
			session: sess,
			model,
			attempts,
		} = createHarness({
			sessionSettings: {
				"retry.enabled": true,
				"retry.codexCloudflare403RetryOnce": true,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					"openai-codex/gpt-6.1-sol": ["openai/gpt-5.5"],
				},
			},
			responses: [cloudflare403(), cloudflare403()],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(2);
		expect(retryStarts).toHaveLength(1);
		expect(retryEnds).toHaveLength(1);
		expect(retryEnds[0].success).toBe(false);
		expect(fallbackEvents).toHaveLength(0);
		expect(sess.model?.provider).toBe(model.provider);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "error", errorStatus: 403 });
	});

	it("does not retry an unrelated 403", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({
			sessionSettings: { "retry.enabled": true, "retry.codexCloudflare403RetryOnce": true },
			responses: [
				{
					stopReason: "error",
					errorStatus: 403,
					errorMessage: "Forbidden: organization account suspended",
					content: [],
				},
			],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(1);
		expect(retryStarts).toHaveLength(0);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "error", errorStatus: 403 });
	});

	it("does not retry a generic 401 even when the body has the Cloudflare signature", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({
			sessionSettings: { "retry.enabled": true, "retry.codexCloudflare403RetryOnce": true },
			responses: [
				{
					...cloudflare403(),
					errorStatus: 401,
				},
			],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(1);
		expect(retryStarts).toHaveLength(0);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "error", errorStatus: 401 });
	});

	it("does not replay a matching 403 after assistant content was emitted", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({
			sessionSettings: { "retry.enabled": true, "retry.codexCloudflare403RetryOnce": true },
			responses: [cloudflare403([{ type: "text", text: "partial output" }])],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(1);
		expect(retryStarts).toHaveLength(0);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "error", errorStatus: 403 });
	});

	it("does not retry when retry.enabled is false even if the option is true", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({
			sessionSettings: { "retry.enabled": false, "retry.codexCloudflare403RetryOnce": true },
			responses: [cloudflare403()],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(1);
		expect(retryStarts).toHaveLength(0);
	});

	it("does not switch to a fallback model", async () => {
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const {
			session: sess,
			model,
			attempts,
		} = createHarness({
			sessionSettings: {
				"retry.enabled": true,
				"retry.codexCloudflare403RetryOnce": true,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					"openai-codex/gpt-6.1-sol": ["openai/gpt-5.5"],
				},
			},
			responses: [cloudflare403(), successfulResponse("same model recovered")],
		});
		sess.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await sess.prompt("hello");

		expect(attempts()).toBe(2);
		expect(fallbackEvents).toHaveLength(0);
		expect(sess.model?.provider).toBe(model.provider);
	});

	it("retries in a subagent AgentSession", async () => {
		const retryStarts: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const { session: sess, attempts } = createHarness({
			agentId: "TaskWorker-1",
			agentKind: "sub",
			sessionSettings: { "retry.enabled": true, "retry.codexCloudflare403RetryOnce": true },
			responses: [cloudflare403(), successfulResponse("subagent finished")],
		});
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		await sess.prompt("run task");

		expect(attempts()).toBe(2);
		expect(retryStarts).toHaveLength(1);
		expect(lastAssistant(sess)).toMatchObject({ stopReason: "stop" });
	});
});
