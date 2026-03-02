import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEvalWorker } from "./src/runtime/worker.js";

export default function (pi: ExtensionAPI) {
	void registerEvalWorker(pi).catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to register eval worker: ${message}`);
	});
}
