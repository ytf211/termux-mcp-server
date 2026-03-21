import { randomUUID } from "node:crypto";
import {
	appendFile,
	cp,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCommand } from "./command.js";
import { AppConfig } from "./config.js";
import { AppError, toErrorPayload } from "./errors.js";
import type { AuditLogger } from "./audit.js";
import type { JobManager } from "./jobs.js";
import type { PathPolicy } from "./path-policy.js";
import type { Semaphore } from "./semaphore.js";
import { isRecord, normalizeCwd } from "./utils.js";

type ToolServices = {
	config: AppConfig;
	pathPolicy: PathPolicy;
	audit: AuditLogger;
	jobs: JobManager;
	semaphore: Semaphore;
};

export function registerTools(server: McpServer, services: ToolServices): void {
	const run = createToolRunner(services);

	server.registerTool(
		"fs_read",
		{
			description: "读取文件，可选按字节偏移和长度截取",
			inputSchema: {
				path: z.string(),
				encoding: z.enum(["utf8", "base64"]).default("utf8"),
				offset: z.number().int().min(0).optional(),
				length: z.number().int().positive().optional(),
			},
		},
		run("fs_read", async (args) => {
			const absPath = await services.pathPolicy.assertAllowed(args.path);
			const file = await readFile(absPath);
			const start = args.offset ?? 0;
			const end = args.length ? Math.min(file.length, start + args.length) : file.length;
			const slice = file.subarray(start, end);

			return {
				path: absPath,
				size: file.length,
				offset: start,
				length: slice.length,
				encoding: args.encoding,
				data: args.encoding === "base64" ? slice.toString("base64") : slice.toString("utf8"),
			};
		}),
	);

	server.registerTool(
		"fs_copy_move",
		{
			description: "复制或移动文件/目录",
			inputSchema: {
				sourcePath: z.string(),
				destinationPath: z.string(),
				mode: z.enum(["copy", "move"]),
				overwrite: z.boolean().default(false),
				recursive: z.boolean().default(true),
			},
		},
		run("fs_copy_move", async (args) => {
			const source = await services.pathPolicy.assertAllowed(args.sourcePath);
			const destination = await services.pathPolicy.assertAllowed(args.destinationPath);

			if (args.mode === "copy") {
				await cp(source, destination, {
					recursive: args.recursive,
					force: args.overwrite,
					errorOnExist: !args.overwrite,
					preserveTimestamps: true,
				});
			} else {
				await movePath(source, destination, args.overwrite, args.recursive);
			}

			return {
				mode: args.mode,
				sourcePath: source,
				destinationPath: destination,
				overwrite: args.overwrite,
			};
		}),
	);

	server.registerTool(
		"exec_run",
		{
			description: "前台执行命令",
			inputSchema: {
				cmd: z.string(),
				args: z.array(z.string()).default([]),
				shell: z.boolean().default(false),
				cwd: z.string().optional(),
				env: z.record(z.string(), z.string()).optional(),
				timeoutMs: z.number().int().positive().optional(),
				maxOutputBytes: z.number().int().positive().optional(),
			},
		},
		run("exec_run", async (args) => {
			const cwd = args.cwd ? await services.pathPolicy.assertAllowed(args.cwd) : undefined;
			const timeoutMs = clampOptional(
				args.timeoutMs,
				services.config.limits.commandTimeoutMs,
				services.config.limits.commandTimeoutMs,
			);
			const maxOutputBytes = clampOptional(
				args.maxOutputBytes,
				services.config.limits.commandOutputMaxBytes,
				services.config.limits.commandOutputMaxBytes,
			);

			const result = await services.semaphore.withPermit(() =>
				runCommand({
					cmd: args.cmd,
					args: args.args,
					shell: args.shell,
					cwd,
					env: args.env,
					timeoutMs,
					maxOutputBytes,
				}),
			);
			return {
				...result,
				cmd: args.cmd,
				args: args.args,
				shell: args.shell,
				cwd: cwd ?? normalizeCwd(undefined),
			};
		}),
	);

	server.registerTool(
		"fs_write",
		{
			description: "写入文件内容（可覆盖）",
			inputSchema: {
				path: z.string(),
				content: z.string(),
				encoding: z.enum(["utf8", "base64"]).default("utf8"),
				createParents: z.boolean().default(true),
				atomic: z.boolean().default(false),
			},
		},
		run("fs_write", async (args) => {
			const absPath = await services.pathPolicy.assertAllowed(args.path);
			const parent = path.dirname(absPath);
			await services.pathPolicy.assertAllowed(parent);
			if (args.createParents) {
				await mkdir(parent, { recursive: true });
			}

			const buffer = decodeContent(args.content, args.encoding);
			if (args.atomic) {
				const tmp = `${absPath}.tmp-${randomUUID()}`;
				await writeFile(tmp, buffer);
				await rename(tmp, absPath);
			} else {
				await writeFile(absPath, buffer);
			}

			return {
				path: absPath,
				bytesWritten: buffer.length,
				atomic: args.atomic,
			};
		}),
	);

	server.registerTool(
		"fs_append",
		{
			description: "向文件追加内容",
			inputSchema: {
				path: z.string(),
				content: z.string(),
				encoding: z.enum(["utf8", "base64"]).default("utf8"),
				createParents: z.boolean().default(true),
			},
		},
		run("fs_append", async (args) => {
			const absPath = await services.pathPolicy.assertAllowed(args.path);
			const parent = path.dirname(absPath);
			await services.pathPolicy.assertAllowed(parent);
			if (args.createParents) {
				await mkdir(parent, { recursive: true });
			}
			const buffer = decodeContent(args.content, args.encoding);
			await appendFile(absPath, buffer);
			return {
				path: absPath,
				bytesAppended: buffer.length,
			};
		}),
	);

	server.registerTool(
		"fs_search",
		{
			description: "按 glob 与文本/正则搜索文件内容",
			inputSchema: {
				rootPath: z.string().default("."),
				fileGlob: z.string().default("**/*"),
				query: z.string().optional(),
				regex: z.string().optional(),
				regexFlags: z.string().default(""),
				caseSensitive: z.boolean().default(false),
				maxResults: z.number().int().positive().max(1000).default(100),
				maxFileBytes: z.number().int().positive().max(5_000_000).default(512_000),
			},
		},
		run("fs_search", async (args) => {
			if (!args.query && !args.regex) {
				throw new AppError("SEARCH_INPUT_INVALID", "query or regex is required");
			}
			if (args.query !== undefined && args.query.length === 0) {
				throw new AppError("SEARCH_INPUT_INVALID", "query cannot be empty");
			}

			const rootPath = await services.pathPolicy.assertAllowed(args.rootPath);
			const files = await fg(args.fileGlob, {
				cwd: rootPath,
				absolute: true,
				onlyFiles: true,
				dot: true,
				followSymbolicLinks: services.config.filesystem.followSymlinks,
				suppressErrors: true,
			});

			const matches: Array<{
				path: string;
				line: number;
				column: number;
				preview: string;
			}> = [];
			const maxResults = args.maxResults;
			const regex = args.regex
				? new RegExp(args.regex, withGlobalFlag(args.regexFlags, true))
				: undefined;

			let scanned = 0;
			for (const filePath of files) {
				if (matches.length >= maxResults) {
					break;
				}

				const absPath = await services.pathPolicy.assertAllowed(filePath);
				const fileStats = await stat(absPath);
				if (fileStats.size > args.maxFileBytes) {
					continue;
				}
				scanned += 1;
				const content = await readFile(absPath, "utf8");

				if (regex) {
					for (const match of content.matchAll(regex)) {
						if (matches.length >= maxResults) {
							break;
						}
						const index = match.index ?? 0;
						const location = getLineColumn(content, index);
						matches.push({
							path: absPath,
							line: location.line,
							column: location.column,
							preview: content.slice(index, index + 160),
						});
					}
					continue;
				}

				const query = args.caseSensitive ? args.query! : args.query!.toLowerCase();
				const haystack = args.caseSensitive ? content : content.toLowerCase();
				let searchFrom = 0;
				while (searchFrom < haystack.length && matches.length < maxResults) {
					const found = haystack.indexOf(query, searchFrom);
					if (found === -1) {
						break;
					}
					const location = getLineColumn(content, found);
					matches.push({
						path: absPath,
						line: location.line,
						column: location.column,
						preview: content.slice(found, found + 160),
					});
					searchFrom = found + Math.max(query.length, 1);
				}
			}

			return {
				rootPath,
				fileGlob: args.fileGlob,
				scannedFiles: scanned,
				matchCount: matches.length,
				truncated: matches.length >= maxResults,
				matches,
			};
		}),
	);

	server.registerTool(
		"exec_bg_start",
		{
			description: "启动后台命令任务",
			inputSchema: {
				cmd: z.string(),
				args: z.array(z.string()).default([]),
				shell: z.boolean().default(false),
				cwd: z.string().optional(),
				env: z.record(z.string(), z.string()).optional(),
			},
		},
		run("exec_bg_start", async (args) => {
			const cwd = args.cwd ? await services.pathPolicy.assertAllowed(args.cwd) : undefined;
			const job = await services.jobs.start({
				cmd: args.cmd,
				args: args.args,
				shell: args.shell,
				cwd,
				env: args.env,
			});
			return job;
		}),
	);

	server.registerTool(
		"exec_bg_list",
		{
			description: "列出后台任务及状态（可附带输出尾部）",
			inputSchema: {
				includeOutputTail: z.boolean().default(false),
				outputTailBytes: z.number().int().positive().max(64_000).default(4096),
			},
		},
		run("exec_bg_list", async (args) => {
			const jobs = await services.jobs.list({
				includeOutputTail: args.includeOutputTail,
				outputTailBytes: args.outputTailBytes,
			});
			return {
				count: jobs.length,
				jobs,
			};
		}),
	);

	server.registerTool(
		"http_fetch",
		{
			description: "使用原生 fetch 发起 HTTP 请求，支持超时与响应截断",
			inputSchema: {
				url: z.string().url(),
				method: z.string().default("GET"),
				headers: z.record(z.string(), z.string()).optional(),
				bodyText: z.string().optional(),
				bodyBase64: z.string().optional(),
				timeoutMs: z.number().int().positive().optional(),
				maxBytes: z.number().int().positive().optional(),
				responseEncoding: z.enum(["auto", "text", "base64"]).default("auto"),
			},
		},
		run("http_fetch", async (args) => {
			if (args.bodyText && args.bodyBase64) {
				throw new AppError(
					"HTTP_INPUT_INVALID",
					"bodyText and bodyBase64 cannot be set together",
				);
			}

			const timeoutMs = clampOptional(
				args.timeoutMs,
				services.config.limits.httpHardTimeoutMs,
				services.config.limits.httpHardTimeoutMs,
			);
			const maxBytes = clampOptional(
				args.maxBytes,
				services.config.limits.httpHardMaxBytes,
				services.config.limits.httpHardMaxBytes,
			);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(args.url, {
					method: args.method,
					headers: args.headers,
					body: args.bodyBase64
						? Buffer.from(args.bodyBase64, "base64")
						: args.bodyText,
					signal: controller.signal,
				});

				const headers: Record<string, string> = {};
				for (const [key, value] of response.headers.entries()) {
					headers[key] = value;
				}

				const contentType = response.headers.get("content-type") ?? "";
				const bodyResult = await readResponseBody(response, maxBytes);
				const encoding = decideEncoding(args.responseEncoding, contentType);
				const body =
					encoding === "base64"
						? bodyResult.buffer.toString("base64")
						: bodyResult.buffer.toString("utf8");

				return {
					url: args.url,
					status: response.status,
					statusText: response.statusText,
					headers,
					encoding,
					bytes: bodyResult.buffer.length,
					truncated: bodyResult.truncated,
					body,
				};
			} catch (error) {
				if ((error as Error).name === "AbortError") {
					throw new AppError("HTTP_TIMEOUT", "http request timed out", {
						details: { timeoutMs },
					});
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
		}),
	);

	server.registerTool(
		"fs_patch",
		{
			description: "使用严格 search/replace 进行局部编辑",
			inputSchema: {
				path: z.string(),
				search: z.string(),
				replace: z.string(),
				useRegex: z.boolean().default(false),
				regexFlags: z.string().default(""),
				expectedCount: z.number().int().min(0).default(1),
			},
		},
		run("fs_patch", async (args) => {
			const absPath = await services.pathPolicy.assertAllowed(args.path);
			const source = await readFile(absPath, "utf8");

			let updated = source;
			let matchCount = 0;
			if (args.useRegex) {
				const regex = new RegExp(args.search, withGlobalFlag(args.regexFlags, true));
				const allMatches = source.matchAll(regex);
				for (const _ of allMatches) {
					matchCount += 1;
				}
				if (matchCount !== args.expectedCount) {
					throw new AppError(
						"PATCH_MATCH_COUNT_MISMATCH",
						"regex match count does not equal expectedCount",
						{
							details: {
								expectedCount: args.expectedCount,
								actualCount: matchCount,
							},
						},
					);
				}
				updated = source.replace(regex, args.replace);
			} else {
				matchCount = countOccurrences(source, args.search);
				if (matchCount !== args.expectedCount) {
					throw new AppError(
						"PATCH_MATCH_COUNT_MISMATCH",
						"match count does not equal expectedCount",
						{
							details: {
								expectedCount: args.expectedCount,
								actualCount: matchCount,
							},
						},
					);
				}
				updated = source.split(args.search).join(args.replace);
			}

			await writeFile(absPath, updated, "utf8");
			return {
				path: absPath,
				matchCount,
				bytesBefore: Buffer.byteLength(source),
				bytesAfter: Buffer.byteLength(updated),
			};
		}),
	);

	server.registerTool(
		"fs_diff",
		{
			description: "输出统一 diff（支持路径模式与 git 模式）",
			inputSchema: {
				mode: z.enum(["path", "git"]).default("path"),
				leftPath: z.string().optional(),
				rightPath: z.string().optional(),
				filePath: z.string().optional(),
				ref: z.string().default("HEAD"),
				repoPath: z.string().default("."),
			},
		},
		run("fs_diff", async (args) => {
			if (args.mode === "path") {
				if (!args.leftPath || !args.rightPath) {
					throw new AppError(
						"DIFF_INPUT_INVALID",
						"leftPath and rightPath are required for path mode",
					);
				}
				const leftPath = await services.pathPolicy.assertAllowed(args.leftPath);
				const rightPath = await services.pathPolicy.assertAllowed(args.rightPath);
				const left = await readFile(leftPath, "utf8");
				const right = await readFile(rightPath, "utf8");
				const diff = createTwoFilesPatch(leftPath, rightPath, left, right, "", "", {
					context: 3,
				});
				return {
					mode: "path",
					leftPath,
					rightPath,
					diff,
				};
			}

			if (!args.filePath) {
				throw new AppError("DIFF_INPUT_INVALID", "filePath is required for git mode");
			}

			const repoPath = await services.pathPolicy.assertAllowed(args.repoPath);
			const worktreePath = await services.pathPolicy.assertAllowed(args.filePath);
			const relativePath = path.relative(repoPath, worktreePath).split(path.sep).join("/");
			if (relativePath.startsWith("..")) {
				throw new AppError("DIFF_INPUT_INVALID", "filePath must be inside repoPath");
			}

			const gitResult = await runCommand({
				cmd: "git",
				args: ["-C", repoPath, "show", `${args.ref}:${relativePath}`],
				timeoutMs: services.config.limits.commandTimeoutMs,
				maxOutputBytes: services.config.limits.commandOutputMaxBytes,
			});
			if (gitResult.exitCode !== 0) {
				throw new AppError("GIT_DIFF_FAILED", "failed to read file from git ref", {
					details: {
						exitCode: gitResult.exitCode,
						stderr: gitResult.stderr,
					},
				});
			}
			if (gitResult.truncated) {
				throw new AppError(
					"GIT_DIFF_TRUNCATED",
					"git output exceeded max bytes; increase commandOutputMaxBytes",
				);
			}

			const current = await readFile(worktreePath, "utf8");
			const diff = createTwoFilesPatch(
				`${args.ref}:${relativePath}`,
				relativePath,
				gitResult.stdout,
				current,
				"",
				"",
				{ context: 3 },
			);
			return {
				mode: "git",
				ref: args.ref,
				repoPath,
				filePath: worktreePath,
				diff,
			};
		}),
	);
}

function createToolRunner(services: ToolServices) {
	return function wrap<TArgs extends Record<string, unknown>, TResult>(
		toolName: string,
		handler: (args: TArgs) => Promise<TResult>,
	) {
		return async (args: TArgs) => {
			const startedAt = Date.now();
			try {
				const result = await handler(args);
				await services.audit.log({
					ts: new Date().toISOString(),
					tool: toolName,
					success: true,
					durationMs: Date.now() - startedAt,
					params: summarizeObject(args),
					result: summarizeObject(result),
				});
				return {
					structuredContent: result,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			} catch (error) {
				const payload = toErrorPayload(error);
				await services.audit.log({
					ts: new Date().toISOString(),
					tool: toolName,
					success: false,
					durationMs: Date.now() - startedAt,
					params: summarizeObject(args),
					error: payload,
				});
				return {
					isError: true,
					structuredContent: payload,
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(payload, null, 2),
						},
					],
				};
			}
		};
	};
}

async function movePath(
	source: string,
	destination: string,
	overwrite: boolean,
	recursive: boolean,
): Promise<void> {
	if (overwrite) {
		await rm(destination, { force: true, recursive: true });
	}
	try {
		await rename(source, destination);
	} catch (error) {
		const errno = (error as NodeJS.ErrnoException).code;
		if (errno !== "EXDEV") {
			throw error;
		}
		await cp(source, destination, {
			recursive,
			force: overwrite,
			errorOnExist: !overwrite,
			preserveTimestamps: true,
		});
		await rm(source, { recursive: true, force: true });
	}
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Buffer {
	if (encoding === "base64") {
		return Buffer.from(content, "base64");
	}
	return Buffer.from(content, "utf8");
}

function getLineColumn(input: string, index: number): { line: number; column: number } {
	const slice = input.slice(0, index);
	const line = slice.split("\n").length;
	const lastBreak = slice.lastIndexOf("\n");
	const column = index - lastBreak;
	return { line, column };
}

function withGlobalFlag(flags: string, enforceGlobal: boolean): string {
	if (!enforceGlobal) {
		return flags;
	}
	return flags.includes("g") ? flags : `${flags}g`;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) {
		throw new AppError("PATCH_INPUT_INVALID", "search pattern cannot be empty");
	}
	let count = 0;
	let index = 0;
	while (index <= haystack.length) {
		const found = haystack.indexOf(needle, index);
		if (found === -1) {
			break;
		}
		count += 1;
		index = found + Math.max(needle.length, 1);
	}
	return count;
}

function clampOptional(
	value: number | undefined,
	defaultValue: number,
	hardMax: number,
): number {
	if (value === undefined) {
		return defaultValue;
	}
	return Math.min(value, hardMax);
}

async function readResponseBody(
	response: Response,
	maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
	if (!response.body) {
		return { buffer: Buffer.alloc(0), truncated: false };
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let remaining = maxBytes;
	let truncated = false;
	try {
		while (remaining > 0) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			const chunk = Buffer.from(next.value);
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				remaining -= chunk.length;
			} else {
				chunks.push(chunk.subarray(0, remaining));
				truncated = true;
				remaining = 0;
				await reader.cancel();
			}
		}
		if (remaining === 0) {
			truncated = true;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// no-op
		}
	}
	return {
		buffer: Buffer.concat(chunks),
		truncated,
	};
}

function decideEncoding(
	input: "auto" | "text" | "base64",
	contentType: string,
): "text" | "base64" {
	if (input === "text" || input === "base64") {
		return input;
	}
	const lowered = contentType.toLowerCase();
	if (
		lowered.startsWith("text/") ||
		lowered.includes("json") ||
		lowered.includes("xml") ||
		lowered.includes("yaml") ||
		lowered.includes("javascript")
	) {
		return "text";
	}
	return "base64";
}

function summarizeObject(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > 400 ? `${value.slice(0, 400)}...[truncated]` : value;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map(summarizeObject);
	}
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value).slice(0, 40);
		for (const [key, item] of entries) {
			result[key] = summarizeObject(item);
		}
		return result;
	}
	return String(value);
}
