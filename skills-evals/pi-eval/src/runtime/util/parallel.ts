export const runItemsInParallel = async <TItem, TResult>(
	items: TItem[],
	parallelism: number,
	runItem: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> => {
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(Math.max(parallelism, 1), items.length) }, async () => {
		while (true) {
			const itemIndex = nextIndex;
			nextIndex += 1;
			if (itemIndex >= items.length) return;
			results[itemIndex] = await runItem(items[itemIndex]);
		}
	});
	await Promise.all(workers);
	return results;
};
