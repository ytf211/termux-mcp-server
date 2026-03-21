import { open } from "node:fs/promises";

export function truncateBuffer(
	buffer: Buffer,
	maxBytes: number,
): { buffer: Buffer; truncated: boolean } {
	if (buffer.length <= maxBytes) {
		return { buffer, truncated: false };
	}
	return {
		buffer: buffer.subarray(0, maxBytes),
		truncated: true,
	};
}

export function truncateString(
	value: string,
	maxChars: number,
): { value: string; truncated: boolean } {
	if (value.length <= maxChars) {
		return { value, truncated: false };
	}
	return {
		value: value.slice(0, maxChars),
		truncated: true,
	};
}

export async function readFileTail(filePath: string, tailBytes: number): Promise<string> {
	const file = await open(filePath, "r");
	try {
		const stats = await file.stat();
		if (stats.size === 0) {
			return "";
		}
		const start = Math.max(0, stats.size - tailBytes);
		const length = stats.size - start;
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, start);
		return buffer.toString("utf8");
	} finally {
		await file.close();
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCwd(cwd?: string): string {
	if (!cwd || cwd.trim() === "") {
		return process.cwd();
	}
	return cwd;
}
