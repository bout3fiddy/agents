export const tokenizeArgs = (input: string): string[] => {
	const tokens: string[] = [];
	const regex = /"([^"]*)"|'([^']*)'|\S+/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(input)) !== null) {
		if (match[1] !== undefined) {
			tokens.push(match[1]);
		} else if (match[2] !== undefined) {
			tokens.push(match[2]);
		} else if (match[0]) {
			tokens.push(match[0]);
		}
	}
	return tokens;
};

type ParsedArgs = {
	positionals: string[];
	flags: Record<string, string | boolean>;
};

export const parseFlags = (tokens: string[]): ParsedArgs => {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) continue;
		if (token.startsWith("--")) {
			const [flag, value] = token.split("=");
			if (value !== undefined) {
				flags[flag] = value;
				continue;
			}

			const next = tokens[i + 1];
			if (next && !next.startsWith("--")) {
				flags[flag] = next;
				i += 1;
			} else {
				flags[flag] = true;
			}
			continue;
		}
		positionals.push(token);
	}

	return { positionals, flags };
};
