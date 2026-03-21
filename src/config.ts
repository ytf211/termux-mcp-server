import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as TOML from "@iarna/toml";
import { AppError } from "./errors.js";

const CONFIG_VERSION = 1;

export type AppConfig = {
	version: number;
	server: {
		host: string;
		port: number;
		path: string;
	};
	auth: {
		enabled: boolean;
	};
	filesystem: {
		followSymlinks: boolean;
		blacklist: {
			prefixes: string[];
			globs: string[];
		};
	};
	limits: {
		commandTimeoutMs: number;
		commandConcurrency: number;
		commandOutputMaxBytes: number;
		backgroundHistoryLimit: number;
		backgroundOutputMaxBytes: number;
		httpHardTimeoutMs: number;
		httpHardMaxBytes: number;
	};
	logging: {
		auditFile: string;
		redactFields: string[];
	};
	jobs: {
		historyFile: string;
		outputDir: string;
	};
};

export type AppSecrets = {
	version: number;
	auth: {
		bearerToken?: string;
	};
};

export type ResolvedSettings = {
	configPath: string;
	secretsPath: string;
	config: AppConfig;
	secrets: AppSecrets;
};

const defaultConfig = (): AppConfig => ({
	version: CONFIG_VERSION,
	server: {
		host: "127.0.0.1",
		port: 8765,
		path: "/mcp",
	},
	auth: {
		enabled: false,
	},
	filesystem: {
		followSymlinks: false,
		blacklist: {
			prefixes: ["/proc", "/sys", "/dev"],
			globs: [],
		},
	},
	limits: {
		commandTimeoutMs: 60_000,
		commandConcurrency: 4,
		commandOutputMaxBytes: 1_048_576,
		backgroundHistoryLimit: 200,
		backgroundOutputMaxBytes: 1_048_576,
		httpHardTimeoutMs: 120_000,
		httpHardMaxBytes: 10 * 1024 * 1024,
	},
	logging: {
		auditFile: "./data/audit.log",
		redactFields: ["authorization", "cookie", "token", "password", "secret", "api_key"],
	},
	jobs: {
		historyFile: "./data/jobs.json",
		outputDir: "./data/jobs",
	},
});

const defaultSecrets = (): AppSecrets => ({
	version: CONFIG_VERSION,
	auth: {},
});

export async function loadSettings(cwd: string): Promise<ResolvedSettings> {
	const configPath = path.resolve(
		cwd,
		process.env.TERMUX_MCP_CONFIG_PATH ?? "config.toml",
	);
	const secretsPath = path.resolve(
		cwd,
		process.env.TERMUX_MCP_SECRETS_PATH ?? "secrets.toml",
	);

	const config = await readOrCreateConfig(configPath);
	const secrets = await readOrCreateSecrets(secretsPath);

	applyEnvironmentOverrides(config, secrets);
	await ensureSecretsToken(config, secrets, secretsPath);

	return {
		configPath,
		secretsPath,
		config,
		secrets,
	};
}

async function readOrCreateConfig(configPath: string): Promise<AppConfig> {
	if (!(await fileExists(configPath))) {
		const config = defaultConfig();
		await writeToml(configPath, config);
		return config;
	}

	const parsed = (await readToml(configPath)) as Partial<AppConfig>;
	const migrated = migrateConfig(parsed);
	const merged = mergeConfig(defaultConfig(), migrated);
	validateConfig(merged);
	return merged;
}

async function readOrCreateSecrets(secretsPath: string): Promise<AppSecrets> {
	if (!(await fileExists(secretsPath))) {
		const secrets = defaultSecrets();
		await writeToml(secretsPath, secrets);
		return secrets;
	}

	const parsed = (await readToml(secretsPath)) as Partial<AppSecrets>;
	const secrets: AppSecrets = {
		version: parsed.version ?? CONFIG_VERSION,
		auth: {
			bearerToken: parsed.auth?.bearerToken,
		},
	};
	return secrets;
}

function migrateConfig(parsed: Partial<AppConfig>): Partial<AppConfig> {
	const fromVersion = parsed.version ?? 1;
	if (fromVersion > CONFIG_VERSION) {
		throw new AppError(
			"CONFIG_VERSION_UNSUPPORTED",
			`config version ${fromVersion} is newer than supported ${CONFIG_VERSION}`,
		);
	}

	let current = { ...parsed };
	for (let v = fromVersion; v < CONFIG_VERSION; v += 1) {
		current = applyConfigMigration(v, current);
	}
	current.version = CONFIG_VERSION;
	return current;
}

function applyConfigMigration(
	version: number,
	config: Partial<AppConfig>,
): Partial<AppConfig> {
	switch (version) {
		default:
			return config;
	}
}

function applyEnvironmentOverrides(config: AppConfig, secrets: AppSecrets): void {
	if (process.env.TERMUX_MCP_PORT) {
		config.server.port = parseIntSafe(process.env.TERMUX_MCP_PORT, "TERMUX_MCP_PORT");
	}
	if (process.env.TERMUX_MCP_HOST) {
		config.server.host = process.env.TERMUX_MCP_HOST;
	}
	if (process.env.TERMUX_MCP_PATH) {
		config.server.path = process.env.TERMUX_MCP_PATH;
	}
	if (process.env.TERMUX_MCP_AUTH_ENABLED) {
		config.auth.enabled = parseBoolSafe(
			process.env.TERMUX_MCP_AUTH_ENABLED,
			"TERMUX_MCP_AUTH_ENABLED",
		);
	}
	if (process.env.TERMUX_MCP_BEARER_TOKEN) {
		secrets.auth.bearerToken = process.env.TERMUX_MCP_BEARER_TOKEN;
	}
}

async function ensureSecretsToken(
	config: AppConfig,
	secrets: AppSecrets,
	secretsPath: string,
): Promise<void> {
	if (!config.auth.enabled) {
		return;
	}
	if (secrets.auth.bearerToken?.trim()) {
		return;
	}

	secrets.auth.bearerToken = randomBytes(32).toString("hex");
	await writeToml(secretsPath, secrets);
	console.error(
		`[auth] bearer token generated and stored in ${secretsPath}. Set auth.enabled=false to disable auth.`,
	);
}

function validateConfig(config: AppConfig): void {
	if (!config.server.path.startsWith("/")) {
		throw new AppError(
			"CONFIG_INVALID_PATH",
			"server.path must start with '/'",
			{ details: { path: config.server.path } },
		);
	}
	if (config.server.port < 1 || config.server.port > 65535) {
		throw new AppError("CONFIG_INVALID_PORT", "server.port must be in [1,65535]");
	}
	if (config.limits.commandConcurrency < 1) {
		throw new AppError("CONFIG_INVALID_CONCURRENCY", "limits.commandConcurrency must be >= 1");
	}
	if (config.limits.backgroundHistoryLimit < 1) {
		throw new AppError(
			"CONFIG_INVALID_JOB_HISTORY",
			"limits.backgroundHistoryLimit must be >= 1",
		);
	}
}

function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
	return {
		...base,
		...override,
		server: {
			...base.server,
			...override.server,
		},
		auth: {
			...base.auth,
			...override.auth,
		},
		filesystem: {
			...base.filesystem,
			...override.filesystem,
			blacklist: {
				...base.filesystem.blacklist,
				...override.filesystem?.blacklist,
			},
		},
		limits: {
			...base.limits,
			...override.limits,
		},
		logging: {
			...base.logging,
			...override.logging,
		},
		jobs: {
			...base.jobs,
			...override.jobs,
		},
		version: CONFIG_VERSION,
	};
}

async function readToml(filePath: string): Promise<unknown> {
	const content = await readFile(filePath, "utf8");
	try {
		return TOML.parse(content);
	} catch (error) {
		throw new AppError("CONFIG_PARSE_ERROR", `failed to parse TOML: ${filePath}`, {
			cause: error,
		});
	}
}

async function writeToml(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const content = TOML.stringify(value as TOML.JsonMap);
	await writeFile(filePath, content, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function parseIntSafe(value: string, envName: string): number {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) {
		throw new AppError("ENV_INVALID_INT", `${envName} must be an integer`);
	}
	return parsed;
}

function parseBoolSafe(value: string, envName: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	throw new AppError("ENV_INVALID_BOOL", `${envName} must be a boolean-like value`);
}
