import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AuditEvent = {
	ts: string;
	tool: string;
	success: boolean;
	durationMs: number;
	params: unknown;
	result?: unknown;
	error?: unknown;
};

export class AuditLogger {
	private readonly filePath: string;
	private readonly redactFields: Set<string>;

	constructor(filePath: string, redactFields: string[]) {
		this.filePath = filePath;
		this.redactFields = new Set(redactFields.map((f) => f.toLowerCase()));
	}

	async log(event: AuditEvent): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const safeEvent = {
			...event,
			params: this.sanitize(event.params),
			result: this.sanitize(event.result),
			error: this.sanitize(event.error),
		};
		await appendFile(this.filePath, `${JSON.stringify(safeEvent)}\n`, "utf8");
	}

	private sanitize(value: unknown, parentKey = ""): unknown {
		if (value === null || value === undefined) {
			return value;
		}

		if (typeof value === "string") {
			const key = parentKey.toLowerCase();
			if (this.shouldRedactKey(key)) {
				return "[REDACTED]";
			}
			if (value.length > 2048) {
				return `${value.slice(0, 2048)}...[truncated ${value.length - 2048} chars]`;
			}
			return value;
		}

		if (typeof value === "number" || typeof value === "boolean") {
			return value;
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.sanitize(item, parentKey));
		}

		if (typeof value === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				if (this.shouldRedactKey(key.toLowerCase())) {
					result[key] = "[REDACTED]";
					continue;
				}
				result[key] = this.sanitize(item, key);
			}
			return result;
		}

		return String(value);
	}

	private shouldRedactKey(key: string): boolean {
		if (this.redactFields.has(key)) {
			return true;
		}
		return (
			key.includes("password") ||
			key.includes("token") ||
			key.includes("secret") ||
			key.includes("authorization") ||
			key.includes("cookie") ||
			key.includes("api_key")
		);
	}
}
