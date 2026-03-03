import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { VM } from "@earendil-works/gondolin";
import { createGondolinSandboxEngine } from "../../src/runtime/gondolin-engine.js";

const TEST_IMAGE_DIR = mkdtempSync(path.join(tmpdir(), "pi-eval-gondolin-image-"));
writeFileSync(
	path.join(TEST_IMAGE_DIR, "manifest.json"),
	JSON.stringify(
		{
			version: 1,
			buildId: "test-build-id",
			assets: {
				kernel: "vmlinuz-virt",
				initramfs: "initramfs.cpio.lz4",
				rootfs: "rootfs.ext4",
			},
		},
		null,
		2,
	),
	"utf-8",
);

const setRequiredImagePathForTest = (): (() => void) => {
	const originalImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
	process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = TEST_IMAGE_DIR;
	return () => {
		if (originalImagePath === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
		} else {
			process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = originalImagePath;
		}
	};
};

test("createGondolinSandboxEngine launches worker with mapped VM options and streams", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	const restoreImagePath = setRequiredImagePathForTest();

	let closed = 0;
	let capturedVmOptions: any = null;
	let capturedExecCall: { command: string; options: Record<string, unknown> } | null = null;
	const writes: string[] = [];
	let stdinEnded = false;

	let execCallCount = 0;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: (chunk: string | Buffer) => writes.push(Buffer.from(chunk).toString("utf8")),
		end: () => {
			stdinEnded = true;
		},
	});

	const fakeVm = {
		exec: (command: string, options: Record<string, unknown>) => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			capturedExecCall = { command, options };
			return fakeProcess;
		},
		close: async () => {
			closed += 1;
		},
	};

	try {
		const engine = createGondolinSandboxEngine({
			createVm: async (options) => {
				capturedVmOptions = options;
				return fakeVm as any;
			},
			createHttpHooks: () =>
				({
					httpHooks: {},
					env: { GONDOLIN_SECRET: "__secret_placeholder__" },
					allowedHosts: ["api.openai.com"],
				}) as any,
		});

		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc", "--model", "gpt-5"],
			env: {
				PI_EVAL_WORKER: "1",
				PI_EVAL_OUTPUT: "/tmp/pi-eval-out/case.json",
			},
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp/workspace",
				workerOutputPath: "/tmp/out/case.json",
				sandboxHomeDir: "/tmp/home",
			},
		});

		assert.equal(Boolean(capturedVmOptions), true);
		assert.equal(Boolean(capturedVmOptions.vfs?.mounts?.["/workspace"]), true);
		assert.equal(Boolean(capturedVmOptions.vfs?.mounts?.["/home/sandbox"]), true);
		assert.equal(Boolean(capturedVmOptions.vfs?.mounts?.["/tmp/pi-eval-out"]), true);
		assert.equal(Boolean(capturedExecCall), true);
		assert.equal(capturedExecCall?.options.cwd, "/workspace");
		assert.equal(capturedExecCall?.options.stdin, true);
		assert.equal(capturedExecCall?.options.stdout, "pipe");
		assert.equal(capturedExecCall?.options.stderr, "pipe");
		assert.match(capturedExecCall?.command ?? "", /\bpi\b/);
		assert.match(capturedExecCall?.command ?? "", /--mode rpc/);

		handle.stdin.write("prompt payload\n");
		handle.stdin.end();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writes.length > 0, true);
		assert.equal(stdinEnded, true);

		stdout.end();
		stderr.end();
		const exitCode = await handle.waitForExit();
		assert.equal(exitCode, 0);
		await handle.cleanup();
		assert.equal(closed, 1);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine maps cancellation aborts to non-throwing waitForExit", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	const restoreImagePath = setRequiredImagePathForTest();

	let closed = 0;
	let execCallCount = 0;
	let rejectExec: ((error: Error) => void) | null = null;

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = new Promise<{ exitCode: number }>((_resolve, reject) => {
		rejectExec = reject;
	});
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const fakeVm = {
		exec: (_command: string, options: Record<string, unknown>) => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			const signal = options.signal as AbortSignal | undefined;
			signal?.addEventListener(
				"abort",
				() => {
					rejectExec?.(new Error("exec aborted"));
				},
				{ once: true },
			);
			return fakeProcess;
		},
		close: async () => {
			closed += 1;
		},
	};

	try {
		const engine = createGondolinSandboxEngine({
			createVm: async () => fakeVm as any,
			createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		});
		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp/workspace",
				workerOutputPath: "/tmp/out/case.json",
				sandboxHomeDir: "/tmp/home",
			},
		});

		handle.kill();
		const exitCode = await handle.waitForExit();
		assert.equal(exitCode, 137);
		await handle.cleanup();
		assert.equal(closed, 1);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine default path calls VM.create", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	const restoreImagePath = setRequiredImagePathForTest();
	const originalVmCreate = (VM as any).create;

	let createCalls = 0;
	let closed = 0;
	let execCallCount = 0;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const fakeVm = {
		exec: () => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			return fakeProcess;
		},
		checkpoint: async () => {
			throw new Error("checkpoint should not run when checkpoints are disabled");
		},
		close: async () => {
			closed += 1;
		},
	};

	(VM as any).create = async () => {
		createCalls += 1;
		return fakeVm;
	};

	try {
		const engine = createGondolinSandboxEngine({
			createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		});
		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp",
				workerOutputPath: "/tmp/case.json",
				sandboxHomeDir: "/tmp",
			},
		});

		stdout.end();
		stderr.end();
		await handle.waitForExit();
		await handle.cleanup();
		assert.equal(createCalls, 1);
		assert.equal(closed, 1);
	} finally {
		(VM as any).create = originalVmCreate;
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine creates and resumes checkpoint when enabled", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const restoreImagePath = setRequiredImagePathForTest();

	let ensureGuestAssetsCalls = 0;
	let checkpointCalls = 0;
	let baseVmClosed = 0;
	let resumedVmClosed = 0;
	let loadCheckpointCalls = 0;
	let checkpointCreated = false;
	let lockCreates = 0;
	let execCallCount = 0;

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const resumedVm = {
		exec: () => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			return fakeProcess;
		},
		checkpoint: async () => {
			throw new Error("checkpoint should not be called on resumed VM");
		},
		close: async () => {
			resumedVmClosed += 1;
		},
	};

	const baseVm = {
		exec: () => {
			throw new Error("base VM should not execute worker directly");
		},
		checkpoint: async () => {
			checkpointCalls += 1;
			checkpointCreated = true;
		},
		close: async () => {
			baseVmClosed += 1;
		},
	};

	const engine = createGondolinSandboxEngine({
		createVm: async () => baseVm as any,
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		ensureGuestAssets: async () => {
			ensureGuestAssetsCalls += 1;
		},
		loadCheckpoint: () => {
			loadCheckpointCalls += 1;
			return {
				resume: async () => resumedVm as any,
			};
		},
		pathExists: async (targetPath) =>
			targetPath === TEST_IMAGE_DIR ||
			targetPath === path.join(TEST_IMAGE_DIR, "manifest.json")
				? true
				: checkpointCreated,
		ensureDirectory: async () => undefined,
		createLockDirectory: async () => {
			lockCreates += 1;
		},
		removePath: async () => undefined,
		sleep: async () => undefined,
	});

	try {
		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp/workspace",
				workerOutputPath: "/tmp/out/case.json",
				sandboxHomeDir: "/tmp/home",
			},
		});

		stdout.end();
		stderr.end();
		await handle.waitForExit();
		await handle.cleanup();

		assert.equal(ensureGuestAssetsCalls, 1);
		assert.equal(lockCreates, 1);
		assert.equal(checkpointCalls, 1);
		assert.equal(loadCheckpointCalls, 1);
		assert.equal(baseVmClosed, 1);
		assert.equal(resumedVmClosed, 1);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine skips checkpoint flow when rootfs mode is memory", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const originalRootfsMode = process.env.PI_EVAL_GONDOLIN_ROOTFS_MODE;
	delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_ROOTFS_MODE = "memory";
	const restoreImagePath = setRequiredImagePathForTest();

	let createVmCalls = 0;
	let ensureGuestAssetsCalls = 0;
	let loadCheckpointCalls = 0;
	let execCallCount = 0;

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const fakeVm = {
		exec: () => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			return fakeProcess;
		},
		checkpoint: async () => {
			throw new Error("checkpoint should not run for memory rootfs mode");
		},
		close: async () => undefined,
	};

	try {
		const engine = createGondolinSandboxEngine({
			createVm: async () => {
				createVmCalls += 1;
				return fakeVm as any;
			},
			createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
			ensureGuestAssets: async () => {
				ensureGuestAssetsCalls += 1;
			},
			loadCheckpoint: () => {
				loadCheckpointCalls += 1;
				return {
					resume: async () => fakeVm as any,
				};
			},
		});

		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp",
				workerOutputPath: "/tmp/case.json",
				sandboxHomeDir: "/tmp",
			},
		});
		stdout.end();
		stderr.end();
		await handle.waitForExit();
		await handle.cleanup();

		assert.equal(createVmCalls, 1);
		assert.equal(ensureGuestAssetsCalls, 0);
		assert.equal(loadCheckpointCalls, 0);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		if (originalRootfsMode === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_ROOTFS_MODE;
		} else {
			process.env.PI_EVAL_GONDOLIN_ROOTFS_MODE = originalRootfsMode;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine surfaces actionable qemu install hint on ENOENT", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	const restoreImagePath = setRequiredImagePathForTest();

	const engine = createGondolinSandboxEngine({
		createVm: async () => {
			const err = new Error("spawnSync qemu-system-aarch64 ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			err.syscall = "spawnSync qemu-system-aarch64";
			err.path = "qemu-system-aarch64";
			throw err;
		},
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
	});

	try {
		await assert.rejects(
			() =>
				engine.launchWorker({
					command: "pi",
					args: ["--mode", "rpc"],
					env: { PI_EVAL_WORKER: "1" },
					policy: {
						model: {
							provider: "openai",
							id: "gpt-5",
							key: "openai/gpt-5",
							label: "openai/gpt-5",
						},
						sandboxWorkspaceDir: "/tmp",
						workerOutputPath: "/tmp/case.json",
						sandboxHomeDir: "/tmp",
					},
				}),
			(error: unknown) => {
				assert.match(String(error), /Missing required host binary 'qemu-system-aarch64'/);
				assert.match(String(error), /brew install qemu/);
				return true;
			},
		);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine falls back to fresh VM when checkpoint is incompatible", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const restoreImagePath = setRequiredImagePathForTest();

	let createVmCalls = 0;
	let ensureGuestAssetsCalls = 0;
	let loadCheckpointCalls = 0;
	let execCallCount = 0;

	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const fallbackVm = {
		exec: () => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			return fakeProcess;
		},
		checkpoint: async () => {
			throw new Error("checkpoint should not run on fallback VM");
		},
		close: async () => undefined,
	};

	const baseVm = {
		exec: () => {
			throw new Error("base VM should not execute worker");
		},
		checkpoint: async () => {
			throw new Error(
				"cannot checkpoint: guest assets are missing manifest buildId (rebuild guest assets with a newer gondolin build)",
			);
		},
		close: async () => undefined,
	};

	try {
		const engine = createGondolinSandboxEngine({
			createVm: async () => {
				createVmCalls += 1;
				return createVmCalls === 1 ? (baseVm as any) : (fallbackVm as any);
			},
			createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
			ensureGuestAssets: async () => {
				ensureGuestAssetsCalls += 1;
			},
			loadCheckpoint: () => {
				loadCheckpointCalls += 1;
				return {
					resume: async () => fallbackVm as any,
				};
			},
			pathExists: async (targetPath) =>
				targetPath === TEST_IMAGE_DIR ||
				targetPath === path.join(TEST_IMAGE_DIR, "manifest.json"),
			ensureDirectory: async () => undefined,
			createLockDirectory: async () => undefined,
			removePath: async () => undefined,
			sleep: async () => undefined,
		});

		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp",
				workerOutputPath: "/tmp/case.json",
				sandboxHomeDir: "/tmp",
			},
		});
		stdout.end();
		stderr.end();
		await handle.waitForExit();
		await handle.cleanup();

		assert.equal(ensureGuestAssetsCalls, 1);
		assert.equal(loadCheckpointCalls, 0);
		assert.equal(createVmCalls, 2);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});

test("createGondolinSandboxEngine fails fast when image path env var is missing", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const originalImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;

	const engine = createGondolinSandboxEngine({
		createVm: async () => {
			throw new Error("createVm should not be called when image path is missing");
		},
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		pathExists: async () => false,
	});

	try {
		await assert.rejects(
			() =>
				engine.launchWorker({
					command: "pi",
					args: ["--mode", "rpc"],
					env: { PI_EVAL_WORKER: "1" },
					policy: {
						model: {
							provider: "openai",
							id: "gpt-5",
							key: "openai/gpt-5",
							label: "openai/gpt-5",
						},
						sandboxWorkspaceDir: "/tmp",
						workerOutputPath: "/tmp/case.json",
						sandboxHomeDir: "/tmp",
					},
				}),
			(error: unknown) => {
				assert.match(String(error), /Gondolin image path is unset/);
				return true;
			},
		);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		if (originalImagePath === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
		} else {
			process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = originalImagePath;
		}
	}
});

test("createGondolinSandboxEngine fails when image path does not exist", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const originalImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = "/tmp/pi-eval-missing-image-for-test.qcow2";

	const engine = createGondolinSandboxEngine({
		createVm: async () => {
			throw new Error("createVm should not be called when image path is missing");
		},
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		pathExists: async () => false,
	});

	try {
		await assert.rejects(
			() =>
				engine.launchWorker({
					command: "pi",
					args: ["--mode", "rpc"],
					env: { PI_EVAL_WORKER: "1" },
					policy: {
						model: {
							provider: "openai",
							id: "gpt-5",
							key: "openai/gpt-5",
							label: "openai/gpt-5",
						},
						sandboxWorkspaceDir: "/tmp",
						workerOutputPath: "/tmp/case.json",
						sandboxHomeDir: "/tmp",
					},
				}),
			(error: unknown) => {
				assert.match(String(error), /PI_EVAL_GONDOLIN_IMAGE_PATH does not exist/);
				return true;
			},
		);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		if (originalImagePath === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
		} else {
			process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = originalImagePath;
		}
	}
});

test("createGondolinSandboxEngine fails when image path has no manifest", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const originalImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = "/tmp/pi-eval-image-without-manifest";

	const engine = createGondolinSandboxEngine({
		createVm: async () => {
			throw new Error("createVm should not be called when manifest is missing");
		},
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		pathExists: async (targetPath) =>
			targetPath === "/tmp/pi-eval-image-without-manifest",
	});

	try {
		await assert.rejects(
			() =>
				engine.launchWorker({
					command: "pi",
					args: ["--mode", "rpc"],
					env: { PI_EVAL_WORKER: "1" },
					policy: {
						model: {
							provider: "openai",
							id: "gpt-5",
							key: "openai/gpt-5",
							label: "openai/gpt-5",
						},
						sandboxWorkspaceDir: "/tmp",
						workerOutputPath: "/tmp/case.json",
						sandboxHomeDir: "/tmp",
					},
				}),
			(error: unknown) => {
				assert.match(String(error), /missing manifest\.json/);
				return true;
			},
		);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		if (originalImagePath === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
		} else {
			process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = originalImagePath;
		}
	}
});

test("createGondolinSandboxEngine resolves repo image path when env var is missing", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	const originalImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;

	let capturedImagePath: string | null = null;
	let execCallCount = 0;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const execResult = Promise.resolve({ exitCode: 0 });
	const fakeProcess = Object.assign(execResult, {
		stdout,
		stderr,
		write: () => undefined,
		end: () => undefined,
	});

	const suffix = path.join("skills-evals", "gondolin", "image", "current");

	const fakeVm = {
		exec: () => {
			execCallCount += 1;
			if (execCallCount === 1) {
				return Promise.resolve({ exitCode: 0 });
			}
			return fakeProcess;
		},
		checkpoint: async () => undefined,
		close: async () => undefined,
	};

	const engine = createGondolinSandboxEngine({
		createVm: async (options) => {
			capturedImagePath = options.sandbox?.imagePath ?? null;
			return fakeVm as any;
		},
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
		pathExists: async (targetPath) =>
			targetPath.endsWith(`${suffix}${path.sep}manifest.json`) ||
			targetPath.endsWith(suffix),
	});

	try {
		const handle = await engine.launchWorker({
			command: "pi",
			args: ["--mode", "rpc"],
			env: { PI_EVAL_WORKER: "1" },
			policy: {
				model: {
					provider: "openai",
					id: "gpt-5",
					key: "openai/gpt-5",
					label: "openai/gpt-5",
				},
				sandboxWorkspaceDir: "/tmp",
				workerOutputPath: "/tmp/case.json",
				sandboxHomeDir: "/tmp",
			},
		});
		stdout.end();
		stderr.end();
		await handle.waitForExit();
		await handle.cleanup();

		assert.match(capturedImagePath ?? "", /skills-evals\/gondolin\/image\/current$/);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		if (originalImagePath === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_IMAGE_PATH;
		} else {
			process.env.PI_EVAL_GONDOLIN_IMAGE_PATH = originalImagePath;
		}
	}
});

test("createGondolinSandboxEngine fails fast when guest image does not include pi", async () => {
	const originalCheckpointDisable = process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = "1";
	const restoreImagePath = setRequiredImagePathForTest();

	const fakeVm = {
		exec: () => Promise.resolve({ exitCode: 1 }),
		checkpoint: async () => undefined,
		close: async () => undefined,
	};

	const engine = createGondolinSandboxEngine({
		createVm: async () => fakeVm as any,
		createHttpHooks: () => ({ httpHooks: {}, env: {} }) as any,
	});

	try {
		await assert.rejects(
			() =>
				engine.launchWorker({
					command: "pi",
					args: ["--mode", "rpc"],
					env: { PI_EVAL_WORKER: "1" },
					policy: {
						model: {
							provider: "openai",
							id: "gpt-5",
							key: "openai/gpt-5",
							label: "openai/gpt-5",
						},
						sandboxWorkspaceDir: "/tmp",
						workerOutputPath: "/tmp/case.json",
						sandboxHomeDir: "/tmp",
					},
				}),
			(error: unknown) => {
				assert.match(String(error), /Gondolin guest is missing `pi` in PATH/);
				return true;
			},
		);
	} finally {
		if (originalCheckpointDisable === undefined) {
			delete process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE;
		} else {
			process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE = originalCheckpointDisable;
		}
		restoreImagePath();
	}
});
