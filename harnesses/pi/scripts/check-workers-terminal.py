"""Exercise the real Pi CLI in a disposable PTY, without model requests or user sessions.

Run: uv run --with pexpect --with pyte --with pillow scripts/check-workers-terminal.py
"""

import json
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pexpect
import pyte
from PIL import Image, ImageDraw, ImageFont


def record(root, role, task, parent=None, review=None, complete=False):
    """Create explicitly synthetic display data; live-model coverage is in live-workers.ts."""

    identifier = str(uuid.uuid4())
    directory = root / ".pi/traces/harness/workers" / identifier
    directory.mkdir(parents=True)
    now = datetime.now(timezone.utc).isoformat()
    info = {
        "id": identifier,
        "parentId": parent,
        "reviewOf": review,
        "role": role,
        "model": "terminal-fixture/model",
        "task": json.dumps({"task": task, "constraints": ["Preserve persistence semantics."]}),
        "scope": ["design/queue.md"],
        "writeLimits": [] if role == "reviewer" else ["design/**"],
        "output": str(directory / "result.json"),
        "workspace": str(root / "worktrees" / "queue-design"),
        "projectRoot": str(root),
        "pid": os.getpid(),
        "startedAt": now,
        "backend": "claude" if role == "reviewer" else "pi",
    }
    state = {
        "status": "complete" if complete else "running",
        "stage": "complete" if complete else "model",
        "summary": "Changes ready for review." if complete else "Checking recovery boundaries.",
        "updatedAt": now,
    }

    for name, value in [
        ("info", info),
        ("state", state),
        ("mailbox", {"accepting": not complete, "messages": []}),
    ]:
        (directory / f"{name}.json").write_text(json.dumps(value))

    entry = {
        "at": now,
        "role": "assistant",
        "text": "Checking queue recovery and backpressure. Café 🧪 — words stay separated.\n"
        "The accepted capacity is 120. Persistence remains an open design decision.",
    }
    (directory / "conversation.jsonl").write_text(json.dumps(entry) + "\n")
    return identifier


def main():
    """Drive keyboard navigation and resizing against the installed launcher."""

    root = Path(tempfile.mkdtemp(prefix="pi-workers-terminal-")).resolve()
    reports = Path(__file__).resolve().parents[1] / "reports" / f"terminal-{int(time.time())}"
    reports.mkdir(parents=True)
    parent = record(root, "task-coordinator", "Queue design and independent review")
    author = record(root, "task-worker", "Document capacity and overload", parent, complete=True)
    review = record(root, "reviewer", "Review the queue decisions", parent, author)
    other = record(root, "branch-orchestrator", "Independent benchmark branch")
    record(root, "performance", "Measure contention and recovery", other)
    launcher = Path.home() / ".pi/agent/bin/pi-harness"
    child = pexpect.spawn(
        str(launcher),
        ["--no-session"],
        cwd=str(root),
        env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
        encoding="utf-8",
        dimensions=(42, 140),
        timeout=20,
    )
    screen = pyte.Screen(140, 42)
    stream = pyte.Stream(screen)
    raw = (reports / "terminal.ansi").open("w")
    font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)

    def read(seconds=1):
        deadline = time.monotonic() + seconds

        while time.monotonic() < deadline:
            try:
                data = child.read_nonblocking(65536, timeout=0.1)
            except pexpect.TIMEOUT:
                continue

            raw.write(data)
            raw.flush()
            stream.feed(data)

            if "\x1b[6n" in data:
                child.send(f"\x1b[{screen.cursor.y + 1};{screen.cursor.x + 1}R")

            if "\x1b[c" in data:
                child.send("\x1b[?1;2c")

    def capture(name):
        lines = screen.display
        (reports / f"{name}.txt").write_text("\n".join(lines))
        picture = Image.new("RGB", (screen.columns * 9 + 24, screen.lines * 19 + 24), "#16181d")
        draw = ImageDraw.Draw(picture)

        for y, line in enumerate(lines):
            draw.text((12, 12 + y * 19), line, font=font, fill="#d6d9e0")

        picture.save(reports / f"{name}.png")
        return "\n".join(lines)

    def keys(value, seconds=1):
        child.send(value)
        read(seconds)

    try:
        read(5)
        keys("/workers\r", 2)
        active = capture("01-active")
        assert "Active 4" in active and "Past 1" in active, active
        assert "Task / worker" in active and "Latest activity" in active and "Updated" in active
        assert "Queue design and independent review" in active and "Review" in active, active
        keys("\x1b[D")
        folded = capture("01-folded")
        assert "Independent benchmark branch" in folded and "Performance" not in folded, folded
        assert "Queue design and independent review" in folded and "Review" in folded, folded
        keys("\x1b[C")
        assert "Performance" in capture("01-expanded")
        keys("\x1b[B\x1b[B\x1b[B\x1b[D")
        author_folded = capture("01-author-folded")
        assert "Review " not in author_folded and "Changes ready for review." in author_folded
        keys("\x1b[C")
        keys("\t")
        assert "[Past 1]" in capture("02-past")
        keys("\t")

        # The newer independent coordinator is first, followed by its performance worker.
        keys("\x1b[B\x1b[B\x1b[B\x1b[B\r")
        chat = capture("03-conversation")
        assert "Review ·" in chat and "Café" in chat, chat
        keys("d")
        assert "Worker:" in capture("04-details")
        keys("\x1b[F")
        assert "Write access within scope: Read only" in capture("05-details-bottom")
        keys("p")
        assert "Review the queue decisions" in capture("06-prompt")
        keys("pgPlease check restart recovery.\r")
        assert "awaiting delivery" in capture("07-guidance")
        mailbox = root / ".pi/traces/harness/workers" / review / "mailbox.json"
        assert json.loads(mailbox.read_text())["messages"][0]["text"] == (
            "Please check restart recovery."
        )
        keys("\x1b")
        keys("\x0f")
        keys("/workers panel\r")
        assert "/workers to open" in capture("08-panel")
        keys("discussion stays editable")
        assert "discussion stays editable" in capture("09-host-input")
        keys("\x15")
        child.setwinsize(32, 80)
        screen.resize(lines=32, columns=80)
        read(1)
        assert "/workers to open" not in capture("10-narrow-host")
        keys("/workers\r")
        capture("11-narrow-picker")
        child.setwinsize(24, 40)
        screen.resize(lines=24, columns=40)
        read(1)
        narrow = capture("12-small-picker")
        assert "Task / worker" in narrow and "Status" in narrow and "Updated" not in narrow
        keys("\x0f")
        keys("/workers panel\r")
        child.setwinsize(42, 140)
        screen.resize(lines=42, columns=140)
        read(1)
        keys("/reload\r", 3)
        keys("/harness-version\r")
        capture("13-reloaded-version")
        receipts = [
            json.loads(line)
            for path in (root / ".pi/traces/harness/runtime").glob("*.jsonl")
            for line in path.read_text().splitlines()
        ]
        assert len({item["loadId"] for item in receipts}) >= 2, receipts
        assert receipts[-1]["reason"] == "reload", receipts
        expected = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())
        assert receipts[-1]["version"] == expected["version"], receipts
        installed = Path.home() / ".pi/agent/harness-install.json"

        if os.environ.get("PI_VERIFY_INSTALL") == "1":
            receipt = json.loads(installed.read_text())
            assert receipts[-1]["sourceHash"] == receipt["sourceHash"]
            assert receipts[-1]["revision"] == receipt["revision"]

        (reports / "result.json").write_text(json.dumps({"status": "passed", "root": str(root)}))
        print(json.dumps({"status": "passed", "reports": str(reports), "root": str(root)}))
    finally:
        child.terminate(force=True)
        raw.close()


if __name__ == "__main__":
    main()
