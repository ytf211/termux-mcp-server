import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuditLogger } from "./audit.js";
import { loadSettings } from "./config.js";
import { JobManager } from "./jobs.js";
import { PathPolicy } from "./path-policy.js";
import { Semaphore } from "./semaphore.js";
import { registerTools } from "./tools.js";

type SessionContext = {
	server: McpServer;
	transport: StreamableHTTPServerTransport;
};

async function main(): Promise<void> {
	const cwd = process.cwd();
	const settings = await loadSettings(cwd);
	const { config, secrets } = settings;

	const pathPolicy = new PathPolicy({
		followSymlinks: config.filesystem.followSymlinks,
		blacklistPrefixes: config.filesystem.blacklist.prefixes,
		blacklistGlobs: config.filesystem.blacklist.globs,
	});
	const audit = new AuditLogger(
		path.resolve(cwd, config.logging.auditFile),
		config.logging.redactFields,
	);
	const jobs = new JobManager({
		historyFile: path.resolve(cwd, config.jobs.historyFile),
		outputDir: path.resolve(cwd, config.jobs.outputDir),
		maxHistory: config.limits.backgroundHistoryLimit,
		outputMaxBytes: config.limits.backgroundOutputMaxBytes,
	});
	await jobs.init();
	const semaphore = new Semaphore(config.limits.commandConcurrency);

	const sessions = new Map<string, SessionContext>();

	async function newSessionContext(): Promise<SessionContext> {
		const context = {} as SessionContext;
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sessionId) => {
				sessions.set(sessionId, context);
			},
			onsessionclosed: async (sessionId) => {
				const existing = sessions.get(sessionId);
				if (!existing) {
					return;
				}
				await existing.transport.close();
				await existing.server.close();
				sessions.delete(sessionId);
			},
		});
		const server = new McpServer(
			{
				name: "termux-mcp-server",
				version: "0.1.0",
			},
			{
				capabilities: { logging: {} },
			},
		);
		registerTools(server, {
			config,
			pathPolicy,
			audit,
			jobs,
			semaphore,
		});
		context.server = server;
		context.transport = transport;
		await server.connect(transport);
		return context;
	}

	const httpServer = createServer(async (req, res) => {
		try {
			await handleRequest(req, res, {
				configPath: config.server.path,
				authEnabled: config.auth.enabled,
				token: secrets.auth.bearerToken,
				sessions,
				newSessionContext,
			});
		} catch (error) {
			console.error("request handling failed", error);
			if (!res.headersSent) {
				sendJson(res, 500, {
					jsonrpc: "2.0",
					error: {
						code: -32603,
						message: "Internal server error",
					},
					id: null,
				});
			}
		}
	});

	httpServer.listen(config.server.port, config.server.host, () => {
		console.error(
			`Termux MCP server listening on http://${config.server.host}:${config.server.port}${config.server.path}`,
		);
		if (config.auth.enabled) {
			console.error("Bearer authentication: enabled");
		} else {
			console.error("Bearer authentication: disabled");
		}
	});

	const closeAll = async () => {
		httpServer.close();
		for (const session of sessions.values()) {
			await session.transport.close();
			await session.server.close();
		}
		process.exit(0);
	};
	process.on("SIGINT", () => void closeAll());
	process.on("SIGTERM", () => void closeAll());
}

type RequestHandlerDependencies = {
	configPath: string;
	authEnabled: boolean;
	token?: string;
	sessions: Map<string, SessionContext>;
	newSessionContext: () => Promise<SessionContext>;
};

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	deps: RequestHandlerDependencies,
): Promise<void> {
	const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	if (requestUrl.pathname === "/healthz") {
		sendJson(res, 200, { ok: true });
		return;
	}

	if (requestUrl.pathname !== deps.configPath) {
		sendJson(res, 404, {
			jsonrpc: "2.0",
			error: { code: -32000, message: "Not found." },
			id: null,
		});
		return;
	}

	if (deps.authEnabled) {
		const ok = validateBearer(req, deps.token);
		if (!ok) {
			res.setHeader("WWW-Authenticate", 'Bearer realm="termux-mcp"');
			sendJson(res, 401, {
				jsonrpc: "2.0",
				error: { code: -32001, message: "Unauthorized" },
				id: null,
			});
			return;
		}
	}

	const sessionId = headerAsSingle(req.headers["mcp-session-id"]);
	const method = req.method ?? "GET";

	if (method === "POST") {
		if (sessionId && !deps.sessions.has(sessionId)) {
			sendJson(res, 404, {
				jsonrpc: "2.0",
				error: { code: -32000, message: "Session not found." },
				id: null,
			});
			return;
		}

		let context = sessionId ? deps.sessions.get(sessionId) : undefined;
		let transientContext = false;
		if (!context) {
			context = await deps.newSessionContext();
			transientContext = true;
		}

		try {
			await context.transport.handleRequest(req, res);
		} finally {
			if (transientContext && !context.transport.sessionId) {
				await context.transport.close();
				await context.server.close();
			}
		}
		return;
	}

	if (method === "GET" || method === "DELETE") {
		if (!sessionId) {
			sendJson(res, 400, {
				jsonrpc: "2.0",
				error: { code: -32000, message: "Missing Mcp-Session-Id header." },
				id: null,
			});
			return;
		}
		const context = deps.sessions.get(sessionId);
		if (!context) {
			sendJson(res, 404, {
				jsonrpc: "2.0",
				error: { code: -32000, message: "Session not found." },
				id: null,
			});
			return;
		}
		await context.transport.handleRequest(req, res);
		return;
	}

	sendJson(res, 405, {
		jsonrpc: "2.0",
		error: { code: -32000, message: "Method not allowed." },
		id: null,
	});
}

function validateBearer(req: IncomingMessage, token?: string): boolean {
	if (!token) {
		return false;
	}
	const auth = req.headers.authorization;
	if (!auth || !auth.startsWith("Bearer ")) {
		return false;
	}
	return auth.slice("Bearer ".length) === token;
}

function headerAsSingle(value: string | string[] | undefined): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return value?.[0];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

main().catch((error) => {
	console.error("fatal startup error", error);
	process.exit(1);
});
