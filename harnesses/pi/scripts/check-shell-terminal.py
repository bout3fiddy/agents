"""Verify shell activity folding, raw expansion and replay in Pi's interactive terminal.

Run: uv run --with pexpect --with pyte scripts/check-shell-terminal.py
"""

import argparse
import os
import subprocess
import tempfile
import time
from pathlib import Path

import pexpect
import pyte


SOURCE = Path(__file__).resolve().parents[1]
FINISHED = "Terminal fixture finished."
RAW_FIRST = "RAW_FIRST_COMMAND"
RAW_SECOND = "RAW_SECOND_COMMAND"
RAW_OUTPUT = "FIRST_OUTPUT_ONLY"
BLOCKER = "guide.md"


def prepare_project(project):
    project.mkdir()

    def git(*arguments):
        subprocess.run(["git", *arguments], cwd=project, check=True, capture_output=True)

    git("init", "--initial-branch=main")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "user.name", "Terminal Fixture")
    git("config", "commit.gpgSign", "false")
    git("config", "core.hooksPath", os.devnull)
    guide = project / "guide.md"
    guide.write_text("base\n")
    git("add", guide.name)
    git("commit", "-m", "Base")
    git("checkout", "-b", "proposal")
    guide.write_text("proposal\n")
    git("commit", "-am", "Proposal subject", "-m", RAW_OUTPUT)
    git("update-ref", "refs/pull/61/head", "HEAD")
    git("checkout", "main")
    guide.write_text("main\n")
    git("commit", "-am", "Main update")


class Terminal:
    def __init__(self, launcher, project, report, args):
        rows, cols = 45, 80
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen)
        self.log = report.open("w")
        self.process = pexpect.spawn(
            str(launcher),
            ["--offline", "--extension", str(SOURCE / "scripts/shell-terminal-provider.ts"),
             "--provider", "shell-terminal", "--model", "scripted", *args],
            cwd=str(project),
            env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
            encoding="utf-8", dimensions=(rows, cols),
        )

    def close(self):
        self.process.terminate(force=True)
        self.log.close()

    def click(self, label):
        row, line = next((y, line) for y, line in enumerate(self.screen.display) if label in line)
        x, y = line.index(label) + 1, row + 1
        self.process.send(f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m")

    def until(self, predicate, description, timeout=25):
        deadline = time.monotonic() + timeout

        while time.monotonic() < deadline:
            try:
                data = self.process.read_nonblocking(65536, timeout=0.1)
            except pexpect.TIMEOUT:
                continue
            except pexpect.EOF:
                break

            self.log.write(data)
            self.log.flush()
            self.stream.feed(data)

            if "\x1b[6n" in data:
                cursor = self.screen.cursor
                self.process.send(f"\x1b[{cursor.y + 1};{cursor.x + 1}R")

            if "\x1b[c" in data:
                self.process.send("\x1b[?1;2c")

            view = "\n".join(self.screen.display)

            if predicate(view):
                return view

        raise AssertionError(description + "\n" + "\n".join(self.screen.display))


def assert_compact(view):
    assert view.count("PR #61") == 1, view
    assert "2 calls" in view and "1 failed" in view, view
    assert BLOCKER in view and "conflict" in view.lower(), view
    assert all(marker not in view for marker in (RAW_FIRST, RAW_SECOND, RAW_OUTPUT)), view


def exercise(launcher, project, reports, resume):
    name = "replay" if resume else "live"
    cli = Terminal(launcher, project, reports / (name + ".ansi"), ["--continue"] if resume else [])

    try:
        if not resume:
            cli.until(lambda view: "Pi harness " in view, "waiting for harness startup")
            cli.process.send("Inspect the proposal and try the local merge.\r")
            running = cli.until(lambda text: "2 calls" in text and "Running" in text,
                                "waiting for grouped in-flight call")
            (reports / "live-running.txt").write_text(running)

        view = cli.until(lambda text: FINISHED in text, "waiting for rendered conversation")
        (reports / (name + "-folded.txt")).write_text(view)
        assert_compact(view)
        initial_render = (reports / (name + ".ansi")).read_text()
        assert all(marker not in initial_render for marker in (RAW_FIRST, RAW_SECOND, RAW_OUTPUT))

        if not resume:
            cli.click("PR #61")
            view = cli.until(lambda text: "Inspect Git state" in text, "opening call list")
            assert "Merge changes" in view, view
            assert all(marker not in view for marker in (RAW_FIRST, RAW_SECOND, RAW_OUTPUT)), view
            cli.click("Inspect Git state")
            view = cli.until(lambda text: RAW_OUTPUT in text, "expanding one shell call")
            assert RAW_FIRST in view and RAW_SECOND not in view, view
            (reports / "live-one-call.txt").write_text(view)
            cli.click("PR #61")
            view = cli.until(lambda text: "Click for calls" in text, "closing call list")
            assert_compact(view)

        cli.process.send("\x0f")
        view = cli.until(lambda text: RAW_FIRST in text and RAW_SECOND in text,
                         "expanding both shell commands")
        (reports / (name + "-expanded.txt")).write_text(view)
        assert RAW_OUTPUT in view and "Merge conflict in guide.md" in view, view
        cli.process.send("\x0f")
        view = cli.until(lambda text: RAW_FIRST not in text and RAW_SECOND not in text,
                         "collapsing raw commands")
        assert_compact(view)
    finally:
        cli.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launcher", type=Path, help="Use an existing installed Pi launcher")
    launcher = parser.parse_args().launcher
    os.environ.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    reports = SOURCE / "reports" / f"shell-terminal-{time.time_ns()}"
    reports.mkdir(parents=True)
    print(f"Terminal captures: {reports}", flush=True)

    with tempfile.TemporaryDirectory(prefix="pi-shell-terminal-") as directory:
        root = Path(directory)
        project = root / "project"
        agent = root / "agent"
        prepare_project(project)

        if launcher is None:
            subprocess.run(["node", "--import", "tsx", "scripts/install.ts", str(agent)],
                           cwd=SOURCE, check=True, stdout=subprocess.DEVNULL)
            launcher = agent / "bin/pi-harness"

        exercise(launcher.resolve(), project, reports, False)
        exercise(launcher.resolve(), project, reports, True)

    print("Grouped shell activity, visible conflict and raw toggle passed live and on resume.")


if __name__ == "__main__":
    main()
