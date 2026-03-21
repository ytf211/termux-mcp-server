import { spawn } from "node:child_process";
import { normalizeCwd } from "./utils.js";

export type ExecRequest = {
	cmd: string;
	args?: string[];
	shell?: boolean;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs: number;
	maxOutputBytes: number;
};

export type ExecResult = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
};

export async function runCommand(request: ExecRequest): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve, reject) => {
		const start = Date.now();
		const shell = request.shell === true;
		const cwd = normalizeCwd(request.cwd);
		const child = shell
			? spawn(request.cmd, {
					cwd,
					env: { ...process.env, ...request.env },
					shell: true,
				})
			: spawn(request.cmd, request.args ?? [], {
					cwd,
					env: { ...process.env, ...request.env },
					shell: false,
				});

		const outputMax = Math.max(1024, request.maxOutputBytes);
		let remaining = outputMax;
		let truncated = false;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		const pushChunk = (target: Buffer[], data: Buffer): void => {
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			const accepted = data.length <= remaining ? data : data.subarray(0, remaining);
			if (accepted.length < data.length) {
				truncated = true;
			}
			target.push(Buffer.from(accepted));
			remaining -= accepted.length;
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			pushChunk(stdoutChunks, buffer);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			pushChunk(stderrChunks, buffer);
		});

		child.on("error", reject);

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500).unref();
		}, request.timeoutMs);

		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode,
				signal,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				timedOut,
				truncated,
				durationMs: Date.now() - start,
			});
		});
	});
}
