import path from "node:path";
import { normalizePath } from "../data/utils.js";

export type ReadCapture = {
	skillAttempts: Set<string>;
	skillInvocations: Set<string>;
	skillDenied: Set<string>;
	skillFileAttempts: Set<string>;
	skillFileInvocations: Set<string>;
	skillFileDenied: Set<string>;
	refAttempts: Set<string>;
	refInvocations: Set<string>;
	refDenied: Set<string>;
	readSizes: Map<string, number>;
};

const toRelativePath = (filePath: string, baseDir: string): string => {
	const relative = path.relative(baseDir, filePath);
	return normalizePath(relative.startsWith("..") ? filePath : relative);
};

const toCanonicalRefPath = (absolutePath: string, agentDir: string): string => {
	const normalizedAbsolute = normalizePath(absolutePath);
	const skillsMarker = "/skills/";
	const markerIndex = normalizedAbsolute.lastIndexOf(skillsMarker);
	if (markerIndex >= 0) {
		return normalizedAbsolute.slice(markerIndex + 1);
	}
	return toRelativePath(absolutePath, agentDir);
};

export const isSkillPath = (filePath: string): boolean =>
	normalizePath(filePath).endsWith("/SKILL.md");

export const isReferencePath = (filePath: string): boolean => {
	const normalized = normalizePath(filePath);
	return normalized.includes("/references/") && normalized.endsWith(".md");
};

const inferSkillNameFromPath = (filePath: string): string | null => {
	const normalized = normalizePath(filePath);
	const marker = "/skills/";
	const start = normalized.lastIndexOf(marker);
	if (start === -1) return null;
	const suffix = normalized.slice(start + marker.length);
	const [skillName] = suffix.split("/", 1);
	if (!skillName) return null;
	return skillName;
};

const resolveCaptureSets = (
	capture: ReadCapture,
	mode: "attempt" | "invocation" | "denied",
) => {
	if (mode === "attempt") {
		return {
			skillSet: capture.skillAttempts,
			skillFileSet: capture.skillFileAttempts,
			refSet: capture.refAttempts,
		};
	}
	if (mode === "invocation") {
		return {
			skillSet: capture.skillInvocations,
			skillFileSet: capture.skillFileInvocations,
			refSet: capture.refInvocations,
		};
	}
	return {
		skillSet: capture.skillDenied,
		skillFileSet: capture.skillFileDenied,
		refSet: capture.refDenied,
	};
};

const captureRead = (
	capture: ReadCapture,
	absolutePath: string,
	agentDir: string,
	mode: "attempt" | "invocation" | "denied",
) => {
	const { skillSet, skillFileSet, refSet } = resolveCaptureSets(capture, mode);
	if (isSkillPath(absolutePath)) {
		const skillName = path.basename(path.dirname(absolutePath));
		skillSet.add(skillName);
		skillFileSet.add(skillName);
	}
	if (isReferencePath(absolutePath)) {
		refSet.add(toCanonicalRefPath(absolutePath, agentDir));
		const inferredSkill = inferSkillNameFromPath(absolutePath);
		if (inferredSkill) skillSet.add(inferredSkill);
	}
};

export const captureReadAttempt = (
	absolutePath: string,
	agentDir: string,
	capture: ReadCapture,
) => {
	captureRead(capture, absolutePath, agentDir, "attempt");
};

export const captureReadInvocation = (
	absolutePath: string,
	agentDir: string,
	capture: ReadCapture,
) => {
	captureRead(capture, absolutePath, agentDir, "invocation");
};

export const captureReadDenied = (
	absolutePath: string,
	agentDir: string,
	capture: ReadCapture,
) => {
	captureRead(capture, absolutePath, agentDir, "denied");
};

export const captureReadSize = (
	canonicalPath: string,
	bytes: number,
	capture: ReadCapture,
): void => {
	capture.readSizes.set(canonicalPath, bytes);
};

const toSortedArray = (items: Set<string>) => Array.from(items).sort();

export const serializeReadCapture = (capture: ReadCapture) => ({
	skillAttempts: toSortedArray(capture.skillAttempts),
	skillInvocations: toSortedArray(capture.skillInvocations),
	skillDenied: toSortedArray(capture.skillDenied),
	skillFileAttempts: toSortedArray(capture.skillFileAttempts),
	skillFileInvocations: toSortedArray(capture.skillFileInvocations),
	skillFileDenied: toSortedArray(capture.skillFileDenied),
	refAttempts: toSortedArray(capture.refAttempts),
	refInvocations: toSortedArray(capture.refInvocations),
	refDenied: toSortedArray(capture.refDenied),
	readSizes: Object.fromEntries(
		Array.from(capture.readSizes.entries()).sort(([a], [b]) => a.localeCompare(b)),
	),
});
