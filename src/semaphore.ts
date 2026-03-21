export class Semaphore {
	private readonly max: number;
	private running = 0;
	private readonly queue: Array<() => void> = [];

	constructor(max: number) {
		this.max = max;
	}

	async withPermit<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.running < this.max) {
			this.running += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.queue.push(() => {
				this.running += 1;
				resolve();
			});
		});
	}

	private release(): void {
		this.running -= 1;
		const next = this.queue.shift();
		if (next) {
			next();
		}
	}
}
