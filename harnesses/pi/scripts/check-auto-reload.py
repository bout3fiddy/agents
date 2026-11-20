"""Exercise a real install and unattended reload in an isolated Pi terminal, without a model."""

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pexpect


def main():
    source = Path(__file__).resolve().parents[1]

    with tempfile.TemporaryDirectory(prefix="pi-auto-reload-") as directory:
        base = Path(directory)
        harness = base / "harness"
        project = base / "project"
        agent = base / "agent"
        project.mkdir()
        harness.mkdir()

        for name in ("src", "prompts", "roles", "scripts"):
            shutil.copytree(source / name, harness / name)

        for name in ("package.json", "package-lock.json"):
            shutil.copy(source / name, harness / name)

        (harness / "node_modules").symlink_to(source / "node_modules")
        installer = ["node", "--import", "tsx", "scripts/install.ts", str(agent)]

        def install():
            subprocess.run(installer, cwd=harness, check=True, stdout=subprocess.DEVNULL)
            return json.loads((agent / "harness-install.json").read_text())["sourceHash"]

        initial = install()
        cli = pexpect.spawn(
            str(agent / "bin/pi-harness"), ["--no-session"], cwd=str(project),
            env={**os.environ, "TERM": "xterm-256color"}, encoding="utf-8", timeout=30,
        )

        try:
            cli.expect("Pi harness ")
            receipts = next((project / ".pi/traces/harness/runtime").glob("*.jsonl"))

            def loads():
                return [json.loads(line) for line in receipts.read_text().splitlines()]

            assert len(loads()) == 1 and loads()[0]["sourceHash"] == initial
            cli.send("unsent design discussion")
            cli.expect("discussion")

            with (harness / "prompts/orchestrator.md").open("a") as prompt:
                prompt.write("\nAuto-reload fixture.\n")

            target = install()
            assert initial != target
            time.sleep(6.5)
            assert len(loads()) == 1, "reloaded with an unsent draft"
            cli.send("\x15")
            cli.expect_exact(target[:10])
            entries = loads()
            assert len(entries) == 2 and entries[-1]["reason"] == "reload", entries
            assert entries[-1]["sourceHash"] == target
            assert entries[0]["session"] == entries[-1]["session"]
            assert entries[0]["pid"] == entries[-1]["pid"]
            cli.send("/workers\r")
            cli.expect("No active subagents")

            with (harness / "prompts/orchestrator.md").open("a") as prompt:
                prompt.write("\nNext fixture generation.\n")

            next_target = install()
            time.sleep(4)
            assert len(loads()) == 2, "worker window closed by automatic reload"
            cli.send("\x0f")
            cli.expect_exact(next_target[:10])
            assert loads()[-1]["sourceHash"] == next_target
            assert install() == next_target
            time.sleep(4)
            assert len(loads()) == 3, "same build reloaded twice"
            assert not (project / ".pi/traces/harness/timing").exists(), "unexpected model turn"
            print("Draft and picker deferred reload. Both builds loaded without a model turn.")
        finally:
            cli.terminate(force=True)


if __name__ == "__main__":
    main()
