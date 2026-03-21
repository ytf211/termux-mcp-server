import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import {
	mkdir,
	open,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";
import { normalizeCwd, readFileTail } from "./utils.js";

export type JobStatus = "running" | "exited" | "failed" | "unknown";

export type JobRecord = {
	id: string;
	cmd: string;
	args: string[];
	shell: boolean;
	cwd: string;
	pid: number;
	startedAt: string;
	endedAt?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	status: JobStatus;
	error?: string;
	stdoutPath: string;
	stderrPath: string;
};

export type StartJobInput = {
	cmd: string;
	args?: string[];
	shell?: boolean;
	cwd?: string;
	env?: Record<string, string>;
};

export class JobManager {
	private readonly historyFile: string;
	private readonly outputDir: string;
	private readonly maxHistory: number;
	private readonly outputMaxBytes: number;
	private readonly jobs = new Map<string, JobRecord>();
	private readonly children = new Map<string, ChildProcess>();

	constructor(options: {
		historyFile: string;
		outputDir: string;
		maxHistory: number;
		outputMaxBytes: number;
	}) {
		this.historyFile = options.historyFile;
		this.outputDir = options.outputDir;
		this.maxHistory = options.maxHistory;
		this.outputMaxBytes = options.outputMaxBytes;
	}

	async init(): Promise<void> {
		await mkdir(path.dirname(this.historyFile), { recursive: true });
		await mkdir(this.outputDir, { recursive: true });
		await this.loadHistory();
		await this.refreshRunningStatuses();
	}

	async start(input: StartJobInput): Promise<JobRecord> {
		const jobId = randomUUID();
		const cwd = normalizeCwd(input.cwd);
		const shell = input.shell === true;
		const args = input.args ?? [];
		const stdoutPath = path.join(this.outputDir, `${jobId}.stdout.log`);
		const stderrPath = path.join(this.outputDir, `${jobId}.stderr.log`);

		const stdoutHandle = await open(stdoutPath, "a");
		const stderrHandle = await open(stderrPath, "a");

		try {
			const child = shell
				? spawn(input.cmd, {
						cwd,
						env: { ...process.env, ...input.env },
						shell: true,
						detached: true,
						stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
					})
				: spawn(input.cmd, args, {
						cwd,
						env: { ...process.env, ...input.env },
						shell: false,
						detached: true,
						stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
					});

			child.unref();

			const record: JobRecord = {
				id: jobId,
				cmd: input.cmd,
				args,
				shell,
				cwd,
				pid: child.pid ?? -1,
				startedAt: new Date().toISOString(),
				status: child.pid ? "running" : "failed",
				error: child.pid ? undefined : "failed to obtain child process pid",
				stdoutPath,
				stderrPath,
			};
			this.jobs.set(jobId, record);
			if (child.pid) {
				this.children.set(jobId, child);
				child.on("exit", async (exitCode, signal) => {
					const existing = this.jobs.get(jobId);
					if (!existing) {
						return;
					}
					existing.status = "exited";
					existing.exitCode = exitCode;
					existing.signal = signal;
					existing.endedAt = new Date().toISOString();
					await this.enforceOutputLimit(existing.stdoutPath);
					await this.enforceOutputLimit(existing.stderrPath);
					await this.persist();
				});
				child.on("error", async (error) => {
					const existing = this.jobs.get(jobId);
					if (!existing) {
						return;
					}
					existing.status = "failed";
					existing.error = error.message;
					existing.endedAt = new Date().toISOString();
					await this.persist();
				});
			}

			await this.persist();
			return record;
		} catch (error) {
			throw new AppError("JOB_START_FAILED", "failed to start background job", {
				cause: error,
			});
		} finally {
			await stdoutHandle.close();
			await stderrHandle.close();
		}
	}

	async list(options?: {
		includeOutputTail?: boolean;
		outputTailBytes?: number;
	}): Promise<Array<JobRecord & { stdoutTail?: string; stderrTail?: string }>> {
		await this.refreshRunningStatuses();
		const includeOutputTail = options?.includeOutputTail === true;
		const outputTailBytes = options?.outputTailBytes ?? 4096;

		const items = Array.from(this.jobs.values())
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, this.maxHistory);

		const result: Array<JobRecord & { stdoutTail?: string; stderrTail?: string }> = [];
		for (const item of items) {
			const row: JobRecord & { stdoutTail?: string; stderrTail?: string } = { ...item };
			if (includeOutputTail) {
				try {
					await this.enforceOutputLimit(item.stdoutPath);
					await this.enforceOutputLimit(item.stderrPath);
					row.stdoutTail = await readFileTail(item.stdoutPath, outputTailBytes);
					row.stderrTail = await readFileTail(item.stderrPath, outputTailBytes);
				} catch {
					row.stdoutTail = "";
					row.stderrTail = "";
				}
			}
			result.push(row);
		}
		return result;
	}

	private async refreshRunningStatuses(): Promise<void> {
		for (const item of this.jobs.values()) {
			if (item.status !== "running") {
				continue;
			}
			try {
				process.kill(item.pid, 0);
			} catch {
				item.status = "unknown";
				item.endedAt = item.endedAt ?? new Date().toISOString();
			}
		}
		await this.persist();
	}

	private async loadHistory(): Promise<void> {
		try {
			const raw = await readFile(this.historyFile, "utf8");
			const parsed = JSON.parse(raw) as JobRecord[];
			for (const item of parsed) {
				this.jobs.set(item.id, item);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw new AppError("JOB_HISTORY_READ_FAILED", "failed to read background job history", {
				cause: error,
			});
		}
	}

	private async persist(): Promise<void> {
		const rows = Array.from(this.jobs.values())
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, this.maxHistory);

		await mkdir(path.dirname(this.historyFile), { recursive: true });
		await writeFile(this.historyFile, JSON.stringify(rows, null, 2), "utf8");
	}

	private async enforceOutputLimit(filePath: string): Promise<void> {
		const stats = await stat(filePath);
		if (stats.size <= this.outputMaxBytes) {
			return;
		}
		const tail = await readFileTail(filePath, this.outputMaxBytes);
		await writeFile(filePath, tail, "utf8");
	}
}
