import boxen from "boxen";
import chalk from "chalk";
import Table from "cli-table3";
import logSymbols from "log-symbols";

const badge = {
	ok: chalk.green("OK"),
	warn: chalk.yellow("WARN"),
	fail: chalk.red("FAIL"),
	skip: chalk.dim("SKIP"),
	dry: chalk.cyan("DRY"),
};

export const symbols = {
	ok: badge.ok,
	warn: badge.warn,
	fail: badge.fail,
	skip: badge.skip,
	dry: badge.dry,
	info: logSymbols.info,
};

export const renderPanel = (title: string, body: string): string =>
	boxen(body, {
		title: chalk.cyan(title),
		padding: { top: 0, bottom: 0, left: 1, right: 1 },
		borderColor: "cyan",
	});

const DEFAULT_MIN_COLUMN_WIDTH = 6;
const DEFAULT_PADDING = 2;
const DEFAULT_MAX_TABLE_WIDTH = 100;

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");
const measure = (value: string | number): number =>
	stripAnsi(String(value ?? ""))
		.split("\n")
		.reduce((max, line) => Math.max(max, line.length), 0);
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const resolveMaxWidth = (maxWidth?: number): number | null => {
	const envWidth = Number.parseInt(process.env.PI_EVAL_TABLE_WIDTH ?? "", 10);
	if (Number.isFinite(envWidth) && envWidth > 0) {
		return envWidth;
	}
	if (typeof maxWidth === "number" && Number.isFinite(maxWidth) && maxWidth > 0) {
		return Math.floor(maxWidth);
	}
	const ttyWidth =
		process.stdout?.isTTY && typeof process.stdout.columns === "number"
			? process.stdout.columns
			: null;
	if (ttyWidth !== null) {
		return ttyWidth;
	}
	return DEFAULT_MAX_TABLE_WIDTH;
};

const computeColumnWidths = (
	head: string[],
	rows: Array<Array<string | number>>,
	options: { maxWidth?: number; minColumnWidth?: number } = {},
): number[] => {
	const columnCount = head.length;
	const minColumnWidth = options.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
	const contentWidths = Array.from({ length: columnCount }, (_, idx) => measure(head[idx] ?? ""));

	for (const row of rows) {
		for (let i = 0; i < columnCount; i += 1) {
			contentWidths[i] = Math.max(contentWidths[i], measure(row[i] ?? ""));
		}
	}

	const maxWidth = resolveMaxWidth(options.maxWidth);
	if (!maxWidth) {
		return contentWidths.map((width) => width + DEFAULT_PADDING);
	}

	const borderWidth = columnCount + 1;
	const available = Math.max(columnCount, maxWidth - borderWidth);
	const availableContent = Math.max(columnCount, available - DEFAULT_PADDING * columnCount);

	const minContentWidths = contentWidths.map((width, idx) => {
		const headLength = measure(head[idx] ?? "");
		const minWidth = Math.max(minColumnWidth, headLength);
		return Math.min(width, minWidth);
	});

	const minTotal = sum(minContentWidths);
	if (availableContent <= minTotal) {
		return minContentWidths.map((width) => width + DEFAULT_PADDING);
	}

	const totalContent = sum(contentWidths);
	if (totalContent <= availableContent) {
		return contentWidths.map((width) => width + DEFAULT_PADDING);
	}

	const widths = [...minContentWidths];
	let remaining = availableContent - minTotal;
	const desiredExtras = contentWidths.map((width, idx) => Math.max(0, width - widths[idx]));
	const weights = desiredExtras.map((extra) => (extra > 0 ? Math.sqrt(extra) : 0));
	const weightSum = sum(weights);

	if (remaining > 0 && weightSum > 0) {
		for (let i = 0; i < columnCount; i += 1) {
			if (weights[i] <= 0) continue;
			const share = Math.min(
				desiredExtras[i],
				Math.floor((weights[i] / weightSum) * remaining),
			);
			if (share <= 0) continue;
			widths[i] += share;
			desiredExtras[i] -= share;
			remaining -= share;
		}
	}

	while (remaining > 0) {
		let bestIndex = -1;
		let bestRoom = 0;
		for (let i = 0; i < columnCount; i += 1) {
			if (desiredExtras[i] > bestRoom) {
				bestRoom = desiredExtras[i];
				bestIndex = i;
			}
		}
		if (bestIndex === -1 || bestRoom <= 0) break;
		widths[bestIndex] += 1;
		desiredExtras[bestIndex] -= 1;
		remaining -= 1;
	}

	return widths.map((width) => width + DEFAULT_PADDING);
};

const parseSplitSpec = (raw: string, columnCount: number): number[] | null => {
	if (!raw) return null;
	const parts = raw.split(/[:\s,]+/).map((item) => Number.parseFloat(item));
	if (parts.length !== columnCount || parts.some((value) => !Number.isFinite(value) || value <= 0)) {
		return null;
	}
	const total = sum(parts);
	if (total <= 0) return null;
	return parts.map((value) => value / total);
};

const computeSplitWidths = (
	head: string[],
	rows: Array<Array<string | number>>,
	split: number[],
	options: { maxWidth?: number; minColumnWidth?: number } = {},
): number[] | null => {
	const columnCount = head.length;
	const minColumnWidth = options.minColumnWidth ?? DEFAULT_MIN_COLUMN_WIDTH;
	const maxWidth = resolveMaxWidth(options.maxWidth);
	if (!maxWidth) return null;

	const borderWidth = columnCount + 1;
	const available = Math.max(columnCount, maxWidth - borderWidth);
	const availableContent = Math.max(columnCount, available - DEFAULT_PADDING * columnCount);

	const minContentWidths = head.map((cell) => Math.max(minColumnWidth, measure(cell ?? "")));
	const minTotal = sum(minContentWidths);
	if (availableContent <= minTotal) return null;

	const widths = split.map((ratio, idx) =>
		Math.max(minContentWidths[idx], Math.floor(availableContent * ratio)),
	);
	let used = sum(widths);
	if (used > availableContent) return null;

	let remaining = availableContent - used;
	const order = [...split.keys()].sort((a, b) => split[b] - split[a]);
	let orderIndex = 0;
	while (remaining > 0) {
		const idx = order[orderIndex % order.length] ?? 0;
		widths[idx] += 1;
		remaining -= 1;
		orderIndex += 1;
	}

	return widths.map((width) => width + DEFAULT_PADDING);
};

const sanitizeCell = (value: string | number): string | number =>
	typeof value === "string" ? stripAnsi(value) : value;

export const renderTable = (
	head: string[],
	rows: Array<Array<string | number>>,
	options: { split?: number[] } = {},
): string => {
	const safeHead = head.map((cell) => stripAnsi(cell));
	const safeRows = rows.map((row) => row.map((cell) => sanitizeCell(cell)));
	let splitWidths: number[] | null = null;
	const split = options.split ?? null;
	if (split) {
		splitWidths = computeSplitWidths(safeHead, safeRows, split);
	}
	const table = new Table({
		head: safeHead,
		style: { head: ["cyan"], border: ["dim"] },
		colWidths: splitWidths ?? computeColumnWidths(safeHead, safeRows),
		wordWrap: true,
		wrapOnWordBoundary: true,
	});
	safeRows.forEach((row) => table.push(row));
	return table.toString();
};

type LogStream = "stdout" | "stderr";

const formatTimestamp = (): string => new Date().toISOString();

const formatLine = (line: string): string => `${chalk.dim(`[${formatTimestamp()}]`)} ${line}`;

const writeLines = (lines: string[], stream: LogStream = "stdout") => {
	if (lines.length === 0) return;
	const output = `${lines.join("\n")}\n`;
	if (stream === "stderr") {
		process.stderr.write(output);
	} else {
		process.stdout.write(output);
	}
};

const writeLine = (line: string, stream: LogStream = "stdout") => {
	writeLines([formatLine(line)], stream);
};

export const logWithTimestamp = (message: string, options: { stream?: LogStream } = {}) => {
	writeLine(message, options.stream ?? "stdout");
};

export const logLines = (
	message: string,
	options: { stream?: LogStream; prefix?: string } = {},
) => {
	const prefix = options.prefix ?? "";
	const stream = options.stream ?? "stdout";
	const lines = String(message ?? "").split("\n");
	const formatted = lines.map((line) => formatLine(`${prefix}${line}`));
	writeLines(formatted, stream);
};

export const logPanelWithTimestamp = (
	title: string,
	body: string,
	options: { stream?: LogStream } = {},
) => {
	const panel = renderPanel(title, body);
	logLines(panel, { stream: options.stream });
};

export const color = {
	accent: chalk.cyan,
	muted: chalk.dim,
	success: chalk.green,
	warning: chalk.yellow,
	error: chalk.red,
};
