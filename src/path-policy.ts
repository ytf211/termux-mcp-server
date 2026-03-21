import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { AppError } from "./errors.js";

export type PathPolicyOptions = {
	followSymlinks: boolean;
	blacklistPrefixes: string[];
	blacklistGlobs: string[];
};

export class PathPolicy {
	private readonly followSymlinks: boolean;
	private readonly prefixes: string[];
	private readonly globs: string[];

	constructor(options: PathPolicyOptions) {
		this.followSymlinks = options.followSymlinks;
		this.prefixes = options.blacklistPrefixes.map((p) => path.resolve(p));
		this.globs = options.blacklistGlobs;
	}

	async assertAllowed(inputPath: string): Promise<string> {
		const absPath = path.resolve(inputPath);

		if (!this.followSymlinks) {
			await assertNoSymlinkInPath(absPath);
		}

		const resolvedForPolicy = this.followSymlinks
			? await resolveIfExists(absPath)
			: absPath;

		if (this.isBlocked(resolvedForPolicy)) {
			throw new AppError("PATH_BLOCKED", "path is blocked by blacklist policy", {
				details: { path: resolvedForPolicy },
			});
		}

		return absPath;
	}

	private isBlocked(absPath: string): boolean {
		for (const prefix of this.prefixes) {
			if (absPath === prefix || absPath.startsWith(`${prefix}${path.sep}`)) {
				return true;
			}
		}

		const normalized = absPath.split(path.sep).join("/");
		return this.globs.some((pattern) =>
			minimatch(normalized, pattern, {
				dot: true,
				nocase: false,
			}),
		);
	}
}

async function resolveIfExists(absPath: string): Promise<string> {
	try {
		return await realpath(absPath);
	} catch {
		return absPath;
	}
}

async function assertNoSymlinkInPath(absPath: string): Promise<void> {
	const normalized = path.resolve(absPath);
	const parts = normalized.split(path.sep);

	let current = normalized.startsWith(path.sep) ? path.sep : parts[0] ?? ".";
	const startIndex = normalized.startsWith(path.sep) ? 1 : 0;
	for (let i = startIndex; i < parts.length; i += 1) {
		const part = parts[i];
		if (!part) {
			continue;
		}
		current = path.join(current, part);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) {
				throw new AppError("SYMLINK_BLOCKED", "symbolic link traversal is disabled", {
					details: { path: current },
				});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
	}
}
