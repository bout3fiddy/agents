import {
	VM,
	createHttpHooks,
	ensureGuestAssets,
	MemoryProvider,
	RealFSProvider,
	type VMOptions,
	VmCheckpoint,
} from "@earendil-works/gondolin";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Writable } from "node:stream";
import path from "node:path";
import {
	type SandboxEngine,
	type SandboxLaunchRequest,
	type SandboxedProcessHandle,
	resolveProviderAllowedHosts,
} from "./sandbox-engine.js";

const GUEST_WORKSPACE_DIR = "/workspace";
const GUEST_HOME_DIR = "/home/sandbox";
const CHECKPOINT_LOCK_TIMEOUT_MS = 30_000;
const CHECKPOINT_LOCK_POLL_MS = 100;

type GondolinVm = Pick<VM, "exec" | "close" | "checkpoint">;
type GondolinCheckpoint = {
	resume: (options?: VMOptions) => Promise<GondolinVm>;
};

type GondolinEngineDependencies = {
	createVm: (options: VMOptions) => Promise<GondolinVm>;
	createHttpHooks: typeof createHttpHooks;
	ensureGuestAssets: () => Promise<unknown>;
	loadCheckpoint: (checkpointPath: string) => GondolinCheckpoint;
	pathExists: (targetPath: string) => Promise<boolean>;
	ensureDirectory: (targetPath: string) => Promise<void>;
	createLockDirectory: (targetPath: string) => Promise<void>;
	removePath: (targetPath: string) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
};

const shellEscapeArg = (arg: string): string => {
	if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
};

const buildCommandString = (command: string, args: string[]): string =>
	[command, ...args].map(shellEscapeArg).join(" ");

const normalizeEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
	Object.fromEntries(
		Object.entries(env).flatMap(([key, value]) =>
			typeof value === "string" ? [[key, value]] : []
		),
	);

const resolveRootfsMode = (raw: string | undefined): "readonly" | "memory" | "cow" => {
	const mode = (raw ?? "cow").trim().toLowerCase();
	if (mode === "readonly" || mode === "memory" || mode === "cow") return mode;
	throw new Error(
		`PI_EVAL_GONDOLIN_ROOTFS_MODE must be one of 'readonly', 'memory', or 'cow'; got '${raw ?? ""}'.`,
	);
};

const resolveRepoImagePath = async (
	deps: Pick<GondolinEngineDependencies, "pathExists">,
): Promise<string | null> => {
	const manifestSuffix = path.join(
		"skills-evals",
		"gondolin",
		"image",
		"current",
		"manifest.json",
	);
	let cursor = path.resolve(process.cwd());
	while (true) {
		const manifestPath = path.join(cursor, manifestSuffix);
		if (await deps.pathExists(manifestPath)) {
			return path.dirname(manifestPath);
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return null;
};

const resolveRequiredImagePath = async (
	deps: Pick<GondolinEngineDependencies, "pathExists">,
): Promise<string> => {
	const rawImagePath = process.env.PI_EVAL_GONDOLIN_IMAGE_PATH?.trim() ?? "";
	const imagePath =
		rawImagePath.length > 0
			? path.resolve(rawImagePath)
			: await resolveRepoImagePath(deps);
	if (!imagePath) {
		throw new Error(
			"Gondolin image path is unset. Set PI_EVAL_GONDOLIN_IMAGE_PATH or build the repo image at skills-evals/gondolin/image/current via ./skills-evals/gondolin/scripts/build-image.sh.",
		);
	}
	const exists = await deps.pathExists(imagePath);
	if (!exists) {
		throw new Error(`PI_EVAL_GONDOLIN_IMAGE_PATH does not exist: ${imagePath}`);
	}
	const manifestPath = path.join(imagePath, "manifest.json");
	if (!(await deps.pathExists(manifestPath))) {
		throw new Error(
			`Gondolin image is missing manifest.json: ${manifestPath}. Build or sync the custom image assets before running evals.`,
		);
	}
	return imagePath;
};

const resolveCheckpointEnabled = (): boolean =>
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DISABLE !== "1";

const resolveCheckpointCacheRoot = (): string =>
	process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), ".cache");

const resolveCheckpointDir = (): string =>
	process.env.PI_EVAL_GONDOLIN_CHECKPOINT_DIR?.trim() ||
	path.join(resolveCheckpointCacheRoot(), "pi-eval", "gondolin-checkpoints");

const buildCheckpointPath = (params: {
	imagePath: string | undefined;
	rootfsMode: "readonly" | "memory" | "cow";
}): string => {
	const payload = JSON.stringify({
		imagePath: params.imagePath ?? "default",
		rootfsMode: params.rootfsMode,
		arch: process.arch,
		keyVersion: process.env.PI_EVAL_GONDOLIN_CHECKPOINT_KEY_VERSION ?? "1",
	});
	const digest = createHash("sha256").update(payload).digest("hex").slice(0, 20);
	return path.join(resolveCheckpointDir(), `pi-eval-${digest}.qcow2`);
};

const withCheckpointLock = async <T>(params: {
	checkpointPath: string;
	deps: Pick<GondolinEngineDependencies, "createLockDirectory" | "removePath" | "sleep">;
	fn: () => Promise<T>;
}): Promise<T> => {
	const lockDir = `${params.checkpointPath}.lock`;
	const deadline = Date.now() + CHECKPOINT_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await params.deps.createLockDirectory(lockDir);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for checkpoint lock: ${params.checkpointPath}`);
			}
			await params.deps.sleep(CHECKPOINT_LOCK_POLL_MS);
		}
	}

	try {
		return await params.fn();
	} finally {
		await params.deps.removePath(lockDir).catch(() => undefined);
	}
};

const isCheckpointCompatibilityError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("manifest buildId") ||
		message.includes("checkpoint buildId")
	);
};

const createOrResumeVm = async (params: {
	vmOptions: VMOptions;
	deps: GondolinEngineDependencies;
	imagePath: string | undefined;
	rootfsMode: "readonly" | "memory" | "cow";
}): Promise<GondolinVm> => {
	const { vmOptions, deps, imagePath, rootfsMode } = params;
	// Gondolin disk checkpoints require a writable qcow2 root disk, which is
	// provided by rootfs mode "cow". Other modes run without checkpoint resume.
	if (!resolveCheckpointEnabled() || rootfsMode !== "cow") return deps.createVm(vmOptions);

	await deps.ensureGuestAssets();
	const checkpointPath = buildCheckpointPath({ imagePath, rootfsMode });
	const checkpointDir = path.dirname(checkpointPath);
	await deps.ensureDirectory(checkpointDir);

	if (await deps.pathExists(checkpointPath)) {
		try {
			return await deps.loadCheckpoint(checkpointPath).resume(vmOptions);
		} catch (error) {
			if (!isCheckpointCompatibilityError(error)) throw error;
			await deps.removePath(checkpointPath).catch(() => undefined);
			return deps.createVm(vmOptions);
		}
	}

	try {
		await withCheckpointLock({
			checkpointPath,
			deps,
			fn: async () => {
				if (await deps.pathExists(checkpointPath)) return;
				const baseVm = await deps.createVm(vmOptions);
				try {
					await baseVm.checkpoint(checkpointPath);
				} catch (error) {
					await deps.removePath(checkpointPath).catch(() => undefined);
					throw error;
				} finally {
					await baseVm.close().catch(() => undefined);
				}
			},
		});
	} catch (error) {
		if (!isCheckpointCompatibilityError(error)) throw error;
		return deps.createVm(vmOptions);
	}

	if (!(await deps.pathExists(checkpointPath))) {
		throw new Error(`checkpoint was not created: ${checkpointPath}`);
	}
	try {
		return await deps.loadCheckpoint(checkpointPath).resume(vmOptions);
	} catch (error) {
		if (!isCheckpointCompatibilityError(error)) throw error;
		await deps.removePath(checkpointPath).catch(() => undefined);
		return deps.createVm(vmOptions);
	}
};

const createProcessStdin = (proc: { write: (data: string | Buffer) => void; end: () => void }) =>
	new Writable({
		write(chunk, encoding, callback) {
			try {
				if (Buffer.isBuffer(chunk)) {
					proc.write(chunk);
				} else {
					const resolvedEncoding =
						typeof encoding === "string" && encoding.length > 0 ? encoding : "utf8";
					proc.write(Buffer.from(chunk, resolvedEncoding));
				}
				callback();
			} catch (error) {
				callback(error as Error);
			}
		},
		final(callback) {
			try {
				proc.end();
				callback();
			} catch (error) {
				callback(error as Error);
			}
		},
	});

const assertGuestPiAvailable = async (
	vm: GondolinVm,
	env: Record<string, string>,
): Promise<void> => {
	const probe = vm.exec("command -v pi >/dev/null 2>&1", {
		cwd: GUEST_WORKSPACE_DIR,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const result = await probe;
	if (result.exitCode === 0) return;
	throw new Error(
		"Gondolin guest is missing `pi` in PATH. Rebuild the custom Gondolin image with `pi` installed and set PI_EVAL_GONDOLIN_IMAGE_PATH to that image.",
	);
};

const extractMissingQemuBinary = (value: string): string | null => {
	const match = value.match(/\b(qemu-system-aarch64|qemu-system-arm|qemu-img)\b/);
	return match ? match[1] : null;
};

const normalizeLaunchError = (error: unknown): Error => {
	const err = error instanceof Error ? error : new Error(String(error));
	const errno = (error as NodeJS.ErrnoException)?.code;
	const syscall = (error as NodeJS.ErrnoException)?.syscall ?? "";
	const pathName = (error as NodeJS.ErrnoException)?.path ?? "";
	const haystack = [err.message, syscall, pathName].filter(Boolean).join(" ");
	if (errno !== "ENOENT" && !haystack.includes("ENOENT")) return err;

	const missingBinary = extractMissingQemuBinary(haystack);
	if (!missingBinary) return err;
	const installHint =
		"Install QEMU on macOS with `brew install qemu` or on Debian/Ubuntu with `sudo apt install qemu-system-arm qemu-utils`.";
	return new Error(
		`Missing required host binary '${missingBinary}' for Gondolin sandbox. ${installHint}`,
		{ cause: err },
	);
};

const defaultDependencies: GondolinEngineDependencies = {
	createVm: (options) => VM.create(options),
	createHttpHooks,
	ensureGuestAssets,
	loadCheckpoint: (checkpointPath) => VmCheckpoint.load(checkpointPath),
	pathExists: async (targetPath) =>
		stat(targetPath)
			.then(() => true)
			.catch(() => false),
	ensureDirectory: async (targetPath) => {
		await mkdir(targetPath, { recursive: true });
	},
	createLockDirectory: async (targetPath) => {
		await mkdir(targetPath);
	},
	removePath: async (targetPath) => {
		await rm(targetPath, { recursive: true, force: true });
	},
	sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const createGondolinSandboxEngine = (
	deps: Partial<GondolinEngineDependencies> = {},
): SandboxEngine => {
	const dependencies = { ...defaultDependencies, ...deps };
	return {
		launchWorker: async (request: SandboxLaunchRequest): Promise<SandboxedProcessHandle> => {
			const { command, args, env, policy } = request;
			const allowedHosts = resolveProviderAllowedHosts(policy.model);
			const { httpHooks, env: hookEnv } = dependencies.createHttpHooks({
				allowedHosts,
				blockInternalRanges: true,
			});

			const outputDir = path.resolve(path.dirname(policy.workerOutputPath));
			const workspaceDir = path.resolve(policy.sandboxWorkspaceDir);
			const homeDir = path.resolve(policy.sandboxHomeDir ?? workspaceDir);
			const imagePath = await resolveRequiredImagePath(dependencies);
			const rootfsMode = resolveRootfsMode(process.env.PI_EVAL_GONDOLIN_ROOTFS_MODE);

			const vmEnv = normalizeEnv({
				...env,
				...hookEnv,
				HOME: GUEST_HOME_DIR,
				PI_CODING_AGENT_DIR: `${GUEST_HOME_DIR}/.agents`,
			});

			const vmOptions: VMOptions = {
				sandbox: {
					imagePath,
				},
				rootfs: {
					mode: rootfsMode,
				},
				httpHooks,
				env: vmEnv,
				vfs: {
					mounts: {
						[GUEST_WORKSPACE_DIR]: new RealFSProvider(workspaceDir),
						[GUEST_HOME_DIR]: policy.sandboxHomeDir
							? new RealFSProvider(homeDir)
							: new MemoryProvider(),
						"/tmp/pi-eval-out": new RealFSProvider(outputDir),
					},
				},
			};

			let vm: GondolinVm | null = null;
			try {
				vm = await createOrResumeVm({
					vmOptions,
					deps: dependencies,
					imagePath,
					rootfsMode,
				});
				await assertGuestPiAvailable(vm, vmEnv);
				const abortController = new AbortController();
				const commandString = buildCommandString(command, args);
				const proc = vm.exec(commandString, {
					cwd: GUEST_WORKSPACE_DIR,
					env: vmEnv,
					stdin: true,
					stdout: "pipe",
					stderr: "pipe",
					signal: abortController.signal,
				});

				if (!proc.stdout || !proc.stderr) {
					throw new Error("sandbox worker launch requires piped stdout/stderr");
				}

				const stdin = createProcessStdin(proc);
				let processSettled = false;
				let processCancelled = false;
				const waitForExitPromise = (async (): Promise<number> => {
					try {
						const result = await proc;
						processSettled = true;
						return result.exitCode;
					} catch (error) {
						processSettled = true;
						const message = error instanceof Error ? error.message : String(error);
						if (processCancelled && message.includes("exec aborted")) return 137;
						throw error;
					}
				})();
				const requestCancel = () => {
					if (processSettled || processCancelled) return;
					processCancelled = true;
					abortController.abort();
				};
				let cleanedUp = false;
				const cleanup = async () => {
					if (cleanedUp) return;
					cleanedUp = true;
					requestCancel();
					await waitForExitPromise.catch(() => undefined);
					await vm?.close().catch(() => undefined);
				};

				return {
					stdin,
					stdout: proc.stdout,
					stderr: proc.stderr,
					waitForExit: () => waitForExitPromise,
					kill: () => {
						requestCancel();
						try {
							proc.end();
						} catch {
							// ignore end() errors during cancellation
						}
					},
					cleanup,
				};
			} catch (error) {
				await vm?.close().catch(() => undefined);
				throw normalizeLaunchError(error);
			}
		},
	};
};
