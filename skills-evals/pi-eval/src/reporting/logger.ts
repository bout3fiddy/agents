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

const resolveTableWidth = (): number => {
	const envWidth = Number.parseInt(process.env.PI_EVAL_TABLE_WIDTH ?? "", 10);
	if (Number.isFinite(envWidth) && envWidth > 0) return envWidth;
	if (process.stdout?.isTTY && typeof process.stdout.columns === "number") {
		return process.stdout.columns;
	}
	return 100;
};

const splitToWidths = (
	columnCount: number,
	split: number[] | undefined,
): number[] | undefined => {
	if (!split || split.length !== columnCount) return undefined;
	const total = split.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return undefined;
	const width = Math.max(40, resolveTableWidth() - (columnCount + 1));
	return split.map((value) => Math.max(8, Math.floor((value / total) * width)));
};

const autoWidths = (head: string[], rows: Array<Array<string | number>>): number[] => {
	const maxPerColumn = head.map((cell) => String(cell).length);
	for (const row of rows) {
		for (let i = 0; i < head.length; i += 1) {
			const value = row[i] ?? "";
			const width = String(value).replace(/\u001b\[[0-9;]*m/g, "").length;
			if (width > maxPerColumn[i]) {
				maxPerColumn[i] = width;
			}
		}
	}
	const maxTableWidth = Math.max(40, resolveTableWidth() - (head.length + 1));
	const maxCellWidth = Math.max(8, Math.floor(maxTableWidth / head.length));
	return maxPerColumn.map((width) => Math.min(maxCellWidth, Math.max(8, width + 2)));
};

export const renderTable = (
	head: string[],
	rows: Array<Array<string | number>>,
	options: { split?: number[] } = {},
): string => {
	const colWidths = splitToWidths(head.length, options.split) ?? autoWidths(head, rows);
	const table = new Table({
		head,
		style: { head: ["cyan"], border: ["dim"] },
		colWidths,
		wordWrap: true,
		wrapOnWordBoundary: true,
	});
	rows.forEach((row) => table.push(row));
	return table.toString();
};

export const color = {
	accent: chalk.cyan,
	muted: chalk.dim,
	success: chalk.green,
	warning: chalk.yellow,
	error: chalk.red,
};
