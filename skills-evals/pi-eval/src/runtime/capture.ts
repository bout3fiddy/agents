import path from "node:path";
import { normalizePath } from "../data/utils.js";

export type ReadCapture = {
	skillAttempts: Set<string>;
	skillInvocations: Set<string>;
	refAttempts: Set<string>;
	refInvocations: Set<string>;
};

const toRelativePath = (filePath: string, baseDir: string): string => {
	const relative = path.relative(baseDir, filePath);
	return normalizePath(relative.startsWith("..") ? filePath : relative);
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
	const start = normalized.indexOf(marker);
	if (start === -1) return null;
	const suffix = normalized.slice(start + marker.length);
	const [skillName] = suffix.split("/", 1);
	if (!skillName) return null;
	return skillName;
};

const captureRead = (capture: ReadCapture, absolutePath: string, agentDir: string, invoked: boolean) => {
	const skillSet = invoked ? capture.skillInvocations : capture.skillAttempts;
	const refSet = invoked ? capture.refInvocations : capture.refAttempts;
	if (isSkillPath(absolutePath)) {
		skillSet.add(path.basename(path.dirname(absolutePath)));
	}
	if (isReferencePath(absolutePath)) {
		refSet.add(toRelativePath(absolutePath, agentDir));
		const inferredSkill = inferSkillNameFromPath(absolutePath);
		if (inferredSkill) {
			skillSet.add(inferredSkill);
		}
	}
};

export const captureReadAttempt = (
	absolutePath: string,
	agentDir: string,
	capture: ReadCapture,
) => {
	captureRead(capture, absolutePath, agentDir, false);
};

export const captureReadInvocation = (
	absolutePath: string,
	agentDir: string,
	capture: ReadCapture,
) => {
	captureRead(capture, absolutePath, agentDir, true);
};

const toSortedArray = (items: Set<string>) => Array.from(items).sort();

export const serializeReadCapture = (capture: ReadCapture) => ({
	skillAttempts: toSortedArray(capture.skillAttempts),
	skillInvocations: toSortedArray(capture.skillInvocations),
	refAttempts: toSortedArray(capture.refAttempts),
	refInvocations: toSortedArray(capture.refInvocations),
});
