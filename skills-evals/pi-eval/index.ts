import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEvalCommand } from "./src/runtime/runner.js";
import { registerEvalWorker } from "./src/runtime/worker.js";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_EVAL_WORKER === "1") {
		void registerEvalWorker(pi).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to register eval worker: ${message}`);
		});
		return;
	}

	registerEvalCommand(pi);
}
