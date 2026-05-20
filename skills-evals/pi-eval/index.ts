import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEvalCommand } from "./src/runtime/entry/runner.js";

export default function (pi: ExtensionAPI) {
	registerEvalCommand(pi);
}
