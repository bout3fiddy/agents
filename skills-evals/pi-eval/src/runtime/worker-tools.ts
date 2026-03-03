/**
 * Tool creation and event hooks for the eval worker.
 *
 * Handles read tool construction with sandbox boundary and deny policy
 * enforcement, tool adaptation, and read capture event registration.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import {
	access as fsAccess,
	readdir as fsReadDir,
	readFile as fsReadFile,
	stat as fsStat,
} from "node:fs/promises";
import path from "node:path";
import {
	captureReadAttempt,
	captureReadDenied,
	captureReadInvocation,
	captureReadSize,
	isSkillPath,
	type ReadCapture,
} from "./capture.js";
import { assertReadablePath, createPathDenyPolicy, type PathDenyPolicy } from "./read-policy.js";
import {
	assertWithinSandboxBoundary,
	type SandboxBoundary,
	type ToolWithExecute,
} from "./sandbox-boundary.js";
import type { ToolUsageCapture } from "./worker-accumulator.js";

const DRY_RUN_SKILL_STUB = "Dry-run mode: file content unavailable.";
const DRY_RUN_SKILL_STUB_BUF = Buffer.from(DRY_RUN_SKILL_STUB);

// ── Tool adaptation ─────────────────────────────────────────────────────

export const adaptToolExecute = <T extends ToolWithExecute>(tool: T): T => ({
	...tool,
	execute: (toolCallId: string, args: Record<string, unknown>) =>
		tool.execute(toolCallId, args, undefined),
});

// ── Read tool ───────────────────────────────────────────────────────────

export const createEvalReadTool = async (
	cwd: string,
	agentDir: string,
	dryRunEnabled: boolean,
	readDenyPaths: string[],
	boundary: SandboxBoundary,
	readCapture: ReadCapture,
) => {
	const denyPolicy = await createPathDenyPolicy(cwd, readDenyPaths);
	const base = createReadTool(cwd, {
		operations: {
			access: async (absolutePath: string) => {
				captureReadAttempt(absolutePath, agentDir, readCapture);
				try {
					await assertWithinSandboxBoundary(absolutePath, boundary);
					await assertReadablePath(absolutePath, denyPolicy);
					if (dryRunEnabled && isSkillPath(absolutePath)) {
						captureReadInvocation(absolutePath, agentDir, readCapture);
						return;
					}
					await fsAccess(absolutePath, constants.R_OK);
					captureReadInvocation(absolutePath, agentDir, readCapture);
				} catch (error) {
					captureReadDenied(absolutePath, agentDir, readCapture);
					throw error;
				}
			},
			readFile: async (absolutePath: string) => {
				captureReadAttempt(absolutePath, agentDir, readCapture);
				try {
					await assertWithinSandboxBoundary(absolutePath, boundary);
						await assertReadablePath(absolutePath, denyPolicy);
						if (dryRunEnabled && isSkillPath(absolutePath)) {
							captureReadInvocation(absolutePath, agentDir, readCapture);
							captureReadSize(absolutePath, DRY_RUN_SKILL_STUB_BUF.length, readCapture);
							return DRY_RUN_SKILL_STUB_BUF;
						}
						const stat = await fsStat(absolutePath);
						if (stat.isDirectory()) {
							const entries = await fsReadDir(absolutePath, { withFileTypes: true });
							const listing = entries
								.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
								.sort((left, right) => left.localeCompare(right))
								.join("\n");
							captureReadInvocation(absolutePath, agentDir, readCapture);
							const listingBuf = Buffer.from(listing);
							captureReadSize(absolutePath, listingBuf.length, readCapture);
							return listingBuf;
						}
						const content = await fsReadFile(absolutePath);
						captureReadInvocation(absolutePath, agentDir, readCapture);
						captureReadSize(absolutePath, content.length, readCapture);
						return content;
				} catch (error) {
					captureReadDenied(absolutePath, agentDir, readCapture);
					throw error;
				}
			},
		},
	});

	return { denyPolicy, tool: adaptToolExecute(base) };
};

// ── Read capture factory ────────────────────────────────────────────────

export const createReadCapture = (): ReadCapture => ({
	skillAttempts: new Set<string>(),
	skillInvocations: new Set<string>(),
	skillDenied: new Set<string>(),
	skillFileAttempts: new Set<string>(),
	skillFileInvocations: new Set<string>(),
	skillFileDenied: new Set<string>(),
	refAttempts: new Set<string>(),
	refInvocations: new Set<string>(),
	refDenied: new Set<string>(),
	readSizes: new Map<string, number>(),
});

// ── Tool event helpers ──────────────────────────────────────────────────

export const isSuccessfulToolResultEvent = (event: Record<string, unknown>): boolean => {
	if (typeof event.success === "boolean") return event.success;
	if ("error" in event && event.error) return false;
	return true;
};

export const extractToolPath = (input: unknown): string | null => {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "filePath", "targetPath", "file", "target"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
};

// ── Event hook registration ─────────────────────────────────────────────

export const registerReadCaptureHooks = (
	pi: ExtensionAPI,
	agentDir: string,
	readCapture: ReadCapture,
	toolFailures: Set<string>,
	toolUsage: ToolUsageCapture,
): void => {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		captureReadAttempt(path.resolve(ctx.cwd, rawPath), agentDir, readCapture);
		return undefined;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write") toolUsage.writeCalls += 1;
		if (event.toolName === "edit") toolUsage.editCalls += 1;
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		const rawPath = event.input?.path;
		if (typeof rawPath !== "string") return undefined;
		const absolutePath = path.resolve(ctx.cwd, rawPath);
		if (isSuccessfulToolResultEvent(event as unknown as Record<string, unknown>)) {
			captureReadInvocation(absolutePath, agentDir, readCapture);
		} else {
			captureReadDenied(absolutePath, agentDir, readCapture);
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const eventRecord = event as unknown as Record<string, unknown>;
		if (isSuccessfulToolResultEvent(eventRecord)) return undefined;
		if (event.toolName === "write") toolUsage.writeFailures += 1;
		if (event.toolName === "edit") toolUsage.editFailures += 1;
		const toolPath = extractToolPath(event.input);
		const rawError = eventRecord.error;
		const message = typeof rawError === "string" && rawError.trim().length > 0
			? rawError.trim()
			: "tool returned an unknown error";
		const location = toolPath ? ` (${toolPath})` : "";
		toolFailures.add(`${event.toolName} tool failed${location}: ${message}`);
		return undefined;
	});
};
