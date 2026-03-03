import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEvalCommand } from "./src/runtime/runner.js";

export default function (pi: ExtensionAPI) {
	registerEvalCommand(pi);
}
