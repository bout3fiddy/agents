import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerificationCommand, VerificationResult } from "../../data/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_000;

const appendLimited = (current: string, chunk: string, maxBytes: number): { value: string; truncated: boolean } => {
	if (Buffer.byteLength(current, "utf-8") >= maxBytes) return { value: current, truncated: true };
	const combined = `${current}${chunk}`;
	if (Buffer.byteLength(combined, "utf-8") <= maxBytes) return { value: combined, truncated: false };
	let value = combined;
	while (Buffer.byteLength(value, "utf-8") > maxBytes && value.length > 0) {
		value = value.slice(0, -1);
	}
	return { value: `${value}\n[output truncated]\n`, truncated: true };
};

export const runVerificationCommands = async (
	commands: VerificationCommand[] | undefined,
	cwd: string,
): Promise<{ results: VerificationResult[]; errors: string[] }> => {
	const results: VerificationResult[] = [];
	const errors: string[] = [];
	for (const command of commands ?? []) {
		if (!Array.isArray(command.argv) || command.argv.length === 0) {
			errors.push(`verification '${command.label}' has empty argv`);
			continue;
		}
		const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const startedAt = Date.now();
		let stdout = "";
		let stderr = "";
		let outputTruncated = false;
		let timedOut = false;

		const child = spawn(command.argv[0], command.argv.slice(1), {
			cwd,
			env: {
				...process.env,
				NO_COLOR: "1",
				FORCE_COLOR: "0",
				TERM: "dumb",
				ZIG_GLOBAL_CACHE_DIR: path.join(tmpdir(), "pi-eval-zig-global-cache"),
				ZIG_LOCAL_CACHE_DIR: path.join(cwd, ".zig-cache"),
				...(command.env ?? {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer | string) => {
			const next = appendLimited(stdout, String(chunk), maxOutputBytes);
			stdout = next.value;
			outputTruncated ||= next.truncated;
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			const next = appendLimited(stderr, String(chunk), maxOutputBytes);
			stderr = next.value;
			outputTruncated ||= next.truncated;
		});

		const exitCode = await new Promise<number | null>((resolve) => {
			child.on("close", (code) => resolve(code));
			child.on("error", () => resolve(null));
		});
		clearTimeout(timeout);

		const result: VerificationResult = {
			label: command.label,
			argv: command.argv,
			exitCode,
			durationMs: Date.now() - startedAt,
			timedOut,
			stdout,
			stderr,
			outputTruncated,
		};
		results.push(result);

		const failed = timedOut || exitCode !== 0;
		if (failed && command.allowFailure !== true) {
			const exitText = timedOut ? `timed out after ${timeoutMs}ms` : `exit ${exitCode ?? "unknown"}`;
			errors.push(`verification '${command.label}' failed: ${exitText}`);
		}
	}
	return { results, errors };
};
