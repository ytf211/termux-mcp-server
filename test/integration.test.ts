import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: number | string | null;
	result?: Record<string, unknown>;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
};

type CallToolResult = {
	isError?: boolean;
	structuredContent?: unknown;
	content?: Array<{ type: string; text?: string }>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(projectRoot, "dist", "index.js");

let fixture: TestFixture | undefined;

before(async () => {
	fixture = await startFixture();
});

after(async () => {
	if (fixture) {
		await fixture.stop();
		fixture = undefined;
	}
});

test("initialize + tools/list returns expected tool set", async () => {
	const fx = mustFixture();
	const client = await McpClient.connect(fx.baseUrl);
	const tools = await client.listTools();
	const names = tools.map((tool) => tool.name).sort();

	assert.equal(names.includes("exec_run"), true);
	assert.equal(names.includes("fs_patch"), true);
	assert.equal(names.includes("http_fetch"), true);
	assert.equal(names.includes("fs_diff"), true);
});

test("exec_run executes argv mode command", async () => {
	const fx = mustFixture();
	const client = await McpClient.connect(fx.baseUrl);
	const result = await client.callTool("exec_run", {
		cmd: "echo",
		args: ["hello-termux-mcp"],
		shell: false,
	});
	const payload = structuredPayload(result) as Record<string, unknown>;

	assert.equal(result.isError, undefined);
	assert.equal(payload.exitCode, 0);
	assert.match(String(payload.stdout ?? ""), /hello-termux-mcp/);
});

test("fs_patch updates target file with strict expectedCount", async () => {
	const fx = mustFixture();
	const client = await McpClient.connect(fx.baseUrl);

	const filePath = path.join(fx.workspaceDir, "patch-target.txt");
	await client.callTool("fs_write", {
		path: filePath,
		content: "alpha\nbeta\nbeta\n",
	});
	const patchResult = await client.callTool("fs_patch", {
		path: filePath,
		search: "beta",
		replace: "gamma",
		expectedCount: 2,
		useRegex: false,
	});

	assert.equal(patchResult.isError, undefined);
	const content = await readFile(filePath, "utf8");
	assert.equal(content, "alpha\ngamma\ngamma\n");
});

test("http_fetch supports truncation and timeout", async (t) => {
	const fx = mustFixture();
	const client = await McpClient.connect(fx.baseUrl);

	const mock = await startMockHttpServer();
	t.after(async () => {
		await closeServer(mock.server);
	});

	const truncated = await client.callTool("http_fetch", {
		url: `${mock.baseUrl}/blob`,
		maxBytes: 64,
		responseEncoding: "text",
	});
	const truncatedPayload = structuredPayload(truncated) as Record<string, unknown>;
	assert.equal(truncated.isError, undefined);
	assert.equal(truncatedPayload.truncated, true);
	assert.equal(String(truncatedPayload.body ?? "").length, 64);

	const timedOut = await client.callTool("http_fetch", {
		url: `${mock.baseUrl}/slow`,
		timeoutMs: 50,
	});
	assert.equal(timedOut.isError, true);
	const timeoutPayload = structuredPayload(timedOut) as Record<string, unknown>;
	assert.equal(timeoutPayload.code, "HTTP_TIMEOUT");
});

type TestFixture = {
	baseUrl: string;
	workspaceDir: string;
	stop: () => Promise<void>;
};

async function startFixture(): Promise<TestFixture> {
	const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "termux-mcp-it-"));
	const port = await getFreePort();
	const baseUrl = `http://127.0.0.1:${port}/mcp`;

	const child = spawn(process.execPath, [serverEntry], {
		cwd: workspaceDir,
		env: {
			...process.env,
			TERMUX_MCP_PORT: String(port),
			TERMUX_MCP_AUTH_ENABLED: "false",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let logs = "";
	const collect = (chunk: Buffer | string) => {
		logs += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
		if (logs.length > 20_000) {
			logs = logs.slice(-20_000);
		}
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	try {
		await waitForHealth(`http://127.0.0.1:${port}/healthz`, 12_000, child, () => logs);
	} catch (error) {
		await stopChild(child);
		await rm(workspaceDir, { recursive: true, force: true });
		throw error;
	}

	return {
		baseUrl,
		workspaceDir,
		stop: async () => {
			await stopChild(child);
			await rm(workspaceDir, { recursive: true, force: true });
		},
	};
}

async function waitForHealth(
	url: string,
	timeoutMs: number,
	child: ChildProcessWithoutNullStreams,
	getLogs: () => string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server exited before healthcheck. logs:\n${getLogs()}`);
		}
		try {
			const res = await fetch(url);
			if (res.ok) {
				return;
			}
		} catch {
			// retry
		}
		await sleep(100);
	}
	throw new Error(`server did not become healthy in time. logs:\n${getLogs()}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	child.kill("SIGINT");
	const exitPromise = once(child, "exit");
	await Promise.race([
		exitPromise,
		sleep(2_000).then(() => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		}),
	]);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate free port"));
				return;
			}
			const port = address.port;
			server.close((closeError) => {
				if (closeError) {
					reject(closeError);
					return;
				}
				resolve(port);
			});
		});
		server.on("error", reject);
	});
}

function mustFixture(): TestFixture {
	if (!fixture) {
		throw new Error("test fixture not initialized");
	}
	return fixture;
}

class McpClient {
	private readonly baseUrl: string;
	private sessionId: string;
	private protocolVersion: string;
	private nextId = 1;

	private constructor(baseUrl: string, sessionId: string, protocolVersion: string) {
		this.baseUrl = baseUrl;
		this.sessionId = sessionId;
		this.protocolVersion = protocolVersion;
	}

	static async connect(baseUrl: string): Promise<McpClient> {
		const initBody = {
			jsonrpc: "2.0" as const,
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-05",
				capabilities: {},
				clientInfo: {
					name: "integration-test",
					version: "0.1.0",
				},
			},
		};

		const initResponse = await postJson(baseUrl, initBody);
		const sessionId = initResponse.headers.get("mcp-session-id");
		assert.ok(sessionId, "missing mcp-session-id in initialize response");
		assert.ok(initResponse.message?.result, "missing initialize result");

		const negotiatedVersion = String(initResponse.message.result.protocolVersion);
		const client = new McpClient(baseUrl, sessionId, negotiatedVersion);
		await client.notifyInitialized();
		return client;
	}

	async listTools(): Promise<Array<{ name: string }>> {
		const msg = await this.call("tools/list", {});
		const tools = (msg.result?.tools ?? []) as Array<{ name: string }>;
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const msg = await this.call("tools/call", {
			name,
			arguments: args,
		});
		return (msg.result ?? {}) as CallToolResult;
	}

	private async notifyInitialized(): Promise<void> {
		const response = await postJson(
			this.baseUrl,
			{
				jsonrpc: "2.0",
				method: "notifications/initialized",
			},
			{
				sessionId: this.sessionId,
				protocolVersion: this.protocolVersion,
			},
		);
		assert.equal(response.status, 202);
	}

	private async call(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
		const response = await postJson(
			this.baseUrl,
			{
				jsonrpc: "2.0",
				id: ++this.nextId,
				method,
				params,
			},
			{
				sessionId: this.sessionId,
				protocolVersion: this.protocolVersion,
			},
		);
		if (response.message?.error) {
			throw new Error(
				`json-rpc error ${response.message.error.code}: ${response.message.error.message}`,
			);
		}
		assert.ok(response.message, "missing json-rpc message");
		return response.message;
	}
}

async function postJson(
	url: string,
	body: Record<string, unknown>,
	options?: {
		sessionId?: string;
		protocolVersion?: string;
	},
): Promise<{
	status: number;
	headers: Headers;
	message?: JsonRpcMessage;
	rawBody: string;
}> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (options?.sessionId) {
		headers["mcp-session-id"] = options.sessionId;
	}
	if (options?.protocolVersion) {
		headers["mcp-protocol-version"] = options.protocolVersion;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const rawBody = await response.text();
	const contentType = response.headers.get("content-type") ?? "";

	if (response.status >= 400) {
		throw new Error(`http ${response.status}: ${rawBody}`);
	}
	if (response.status === 202) {
		return {
			status: response.status,
			headers: response.headers,
			rawBody,
		};
	}

	const message = parseMessage(contentType, rawBody);
	return {
		status: response.status,
		headers: response.headers,
		message,
		rawBody,
	};
}

function parseMessage(contentType: string, rawBody: string): JsonRpcMessage {
	if (contentType.includes("text/event-stream")) {
		return parseSseMessage(rawBody);
	}
	return JSON.parse(rawBody) as JsonRpcMessage;
}

function parseSseMessage(rawBody: string): JsonRpcMessage {
	const lines = rawBody.split(/\r?\n/);
	const dataLines = lines.filter((line) => line.startsWith("data:"));
	if (dataLines.length === 0) {
		throw new Error(`cannot parse SSE payload: ${rawBody}`);
	}
	const data = dataLines
		.map((line) => line.slice("data:".length).trimStart())
		.join("\n");
	return JSON.parse(data) as JsonRpcMessage;
}

function structuredPayload(result: CallToolResult): unknown {
	if (result.structuredContent !== undefined) {
		return result.structuredContent;
	}
	const firstText = result.content?.find((item) => item.type === "text" && item.text)?.text;
	if (!firstText) {
		return undefined;
	}
	try {
		return JSON.parse(firstText);
	} catch {
		return firstText;
	}
}

async function startMockHttpServer(): Promise<{ server: Server; baseUrl: string }> {
	const port = await getFreePort();
	const server = createServer((req, res) => {
		if (req.url === "/blob") {
			res.statusCode = 200;
			res.setHeader("content-type", "text/plain; charset=utf-8");
			res.end("x".repeat(4096));
			return;
		}
		if (req.url === "/slow") {
			setTimeout(() => {
				res.statusCode = 200;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ ok: true }));
			}, 300);
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	return {
		server,
		baseUrl: `http://127.0.0.1:${port}`,
	};
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}
