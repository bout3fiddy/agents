import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CliArgs = {
	imageDir: string;
	lockFile: string;
	configFile: string;
	version: string;
	piPackageName: string;
	piPackageVersion: string;
	projectRoot: string;
};

const parseArgs = (argv: string[]): CliArgs => {
	const defaults: CliArgs = {
		imageDir: "",
		lockFile: "",
		configFile: "",
		version: "",
		piPackageName: "@mariozechner/pi-coding-agent",
		piPackageVersion: "0.52.6",
		projectRoot: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const value = argv[index + 1];
		if (!token.startsWith("--")) continue;
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`missing value for ${token}`);
		}
		if (token === "--image-dir") defaults.imageDir = value;
		if (token === "--lock-file") defaults.lockFile = value;
		if (token === "--config-file") defaults.configFile = value;
		if (token === "--version") defaults.version = value;
		if (token === "--pi-package-name") defaults.piPackageName = value;
		if (token === "--pi-package-version") defaults.piPackageVersion = value;
		if (token === "--project-root") defaults.projectRoot = value;
		index += 1;
	}

	if (defaults.imageDir.length === 0) throw new Error("--image-dir is required");
	if (defaults.lockFile.length === 0) throw new Error("--lock-file is required");
	if (defaults.configFile.length === 0) throw new Error("--config-file is required");
	if (defaults.version.length === 0) throw new Error("--version is required");
	if (defaults.projectRoot.length === 0) defaults.projectRoot = process.cwd();
	return defaults;
};

const sha256File = async (targetPath: string): Promise<string> => {
	const hasher = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(targetPath);
		stream.on("data", (chunk) => hasher.update(chunk));
		stream.on("end", () => resolve());
		stream.on("error", (error) => reject(error));
	});
	return hasher.digest("hex");
};

const loadJson = async (targetPath: string): Promise<any> => {
	const raw = await readFile(targetPath, "utf-8");
	return JSON.parse(raw);
};

const main = async (): Promise<void> => {
	const args = parseArgs(process.argv.slice(2));
	const imageDir = path.resolve(args.imageDir);
	const lockFile = path.resolve(args.lockFile);
	const configFile = path.resolve(args.configFile);
	const projectRoot = path.resolve(args.projectRoot);
	const manifestPath = path.join(imageDir, "manifest.json");
	const manifest = await loadJson(manifestPath);

	const toLockPath = (targetPath: string): string => {
		const relative = path.relative(projectRoot, targetPath);
		if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
			return relative.split(path.sep).join("/");
		}
		return targetPath;
	};

	const resolveAssetPath = (key: "kernel" | "initramfs" | "rootfs"): string => {
		const fileName = manifest?.assets?.[key];
		if (typeof fileName !== "string" || fileName.trim().length === 0) {
			throw new Error(`manifest missing assets.${key}`);
		}
		return path.join(imageDir, fileName);
	};

	const kernelPath = resolveAssetPath("kernel");
	const initramfsPath = resolveAssetPath("initramfs");
	const rootfsPath = resolveAssetPath("rootfs");
	const [kernelStat, initramfsStat, rootfsStat] = await Promise.all([
		stat(kernelPath),
		stat(initramfsPath),
		stat(rootfsPath),
	]);

	const [manifestSha256, configSha256, kernelSha256, initramfsSha256, rootfsSha256] =
		await Promise.all([
			sha256File(manifestPath),
			sha256File(configFile),
			sha256File(kernelPath),
			sha256File(initramfsPath),
			sha256File(rootfsPath),
		]);

	const lock = {
		name: "pi-eval-gondolin-image",
		version: args.version,
		generatedAt: new Date().toISOString(),
		buildId: manifest?.buildId ?? null,
		arch: manifest?.config?.arch ?? null,
		imageDir: toLockPath(imageDir),
		piPackage: {
			name: args.piPackageName,
			version: args.piPackageVersion,
		},
		buildConfig: {
			path: toLockPath(configFile),
			sha256: configSha256,
		},
		artifacts: {
			manifest: {
				path: toLockPath(manifestPath),
				sha256: manifestSha256,
			},
			kernel: {
				path: toLockPath(kernelPath),
				sizeBytes: kernelStat.size,
				sha256: kernelSha256,
			},
			initramfs: {
				path: toLockPath(initramfsPath),
				sizeBytes: initramfsStat.size,
				sha256: initramfsSha256,
			},
			rootfs: {
				path: toLockPath(rootfsPath),
				sizeBytes: rootfsStat.size,
				sha256: rootfsSha256,
			},
		},
	};

	await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
	process.stdout.write(`wrote lock file: ${lockFile}\n`);
};

await main();
