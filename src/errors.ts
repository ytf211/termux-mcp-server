export class AppError extends Error {
	readonly code: string;
	readonly details?: unknown;
	readonly statusCode: number;

	constructor(
		code: string,
		message: string,
		options?: {
			details?: unknown;
			statusCode?: number;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "AppError";
		this.code = code;
		this.details = options?.details;
		this.statusCode = options?.statusCode ?? 400;
	}
}

export type ErrorPayload = {
	code: string;
	message: string;
	details?: unknown;
};

export function toErrorPayload(error: unknown): ErrorPayload {
	if (error instanceof AppError) {
		return {
			code: error.code,
			message: error.message,
			details: error.details,
		};
	}

	if (error instanceof Error) {
		return {
			code: "INTERNAL_ERROR",
			message: error.message,
		};
	}

	return {
		code: "INTERNAL_ERROR",
		message: "Unknown error",
		details: error,
	};
}
