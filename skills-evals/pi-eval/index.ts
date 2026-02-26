import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEvalCommand } from "./src/runner.js";
import { registerEvalWorker } from "./src/worker.js";

export default function (pi: ExtensionAPI) {
	if (registerEvalWorker(pi)) {
		return;
	}

	registerEvalCommand(pi);
}
