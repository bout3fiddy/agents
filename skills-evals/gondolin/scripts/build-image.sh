#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PI_EVAL_DIR="$ROOT_DIR/skills-evals/pi-eval"
DEFAULT_CONFIG_PATH="$ROOT_DIR/skills-evals/gondolin/pi-eval-image.json"
DEFAULT_OUTPUT_DIR="$ROOT_DIR/skills-evals/gondolin/image/current"
DEFAULT_LOCK_PATH="$ROOT_DIR/skills-evals/gondolin/image.lock.json"
DEFAULT_GUEST_LOCK_PATH="$ROOT_DIR/skills-evals/gondolin/guest-source.lock.json"
DEFAULT_IMAGE_VERSION="$(date -u +"%Y.%m.%d.%H%M%S")"

CONFIG_PATH="${PI_EVAL_GONDOLIN_BUILD_CONFIG:-$DEFAULT_CONFIG_PATH}"
OUTPUT_DIR="${PI_EVAL_GONDOLIN_IMAGE_OUTPUT:-$DEFAULT_OUTPUT_DIR}"
LOCK_PATH="${PI_EVAL_GONDOLIN_IMAGE_LOCK:-$DEFAULT_LOCK_PATH}"
IMAGE_VERSION="${PI_EVAL_GONDOLIN_IMAGE_VERSION:-$DEFAULT_IMAGE_VERSION}"
PI_PACKAGE_NAME="${PI_EVAL_GONDOLIN_PI_PACKAGE_NAME:-@mariozechner/pi-coding-agent}"
PI_PACKAGE_VERSION="${PI_EVAL_GONDOLIN_PI_PACKAGE_VERSION:-0.52.6}"
GUEST_LOCK_PATH="${PI_EVAL_GONDOLIN_GUEST_LOCK:-$DEFAULT_GUEST_LOCK_PATH}"

if [[ "$#" -gt 0 ]]; then
	echo "build-image.sh takes no CLI args. Configure via env vars only." >&2
	exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
	echo "Build config not found: $CONFIG_PATH" >&2
	exit 1
fi

if [[ ! -d "$PI_EVAL_DIR" ]]; then
	echo "pi-eval package directory not found: $PI_EVAL_DIR" >&2
	exit 1
fi

if [[ ! -f "$GUEST_LOCK_PATH" ]]; then
	echo "Guest source lock not found: $GUEST_LOCK_PATH" >&2
	exit 1
fi

if [[ -z "${GONDOLIN_GUEST_SRC:-}" ]]; then
	GUEST_REPO_URL="$(
		node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.repository || "");' "$GUEST_LOCK_PATH"
	)"
	GUEST_REPO_REF="$(
		node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.ref || "");' "$GUEST_LOCK_PATH"
	)"
	GUEST_RELATIVE_PATH="$(
		node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.guestPath || "guest");' "$GUEST_LOCK_PATH"
	)"

	if [[ -z "$GUEST_REPO_URL" || -z "$GUEST_REPO_REF" ]]; then
		echo "Guest source lock is missing repository/ref fields: $GUEST_LOCK_PATH" >&2
		exit 1
	fi

	GUEST_VENDOR_ROOT="$ROOT_DIR/skills-evals/gondolin/vendor/gondolin"
	GUEST_DIR="$GUEST_VENDOR_ROOT/$GUEST_RELATIVE_PATH"

	if [[ ! -f "$GUEST_DIR/build.zig" ]]; then
		if ! command -v git >/dev/null 2>&1; then
			echo "git is required to fetch Gondolin guest sources." >&2
			exit 1
		fi
		echo "[gondolin-image] syncing guest sources from $GUEST_REPO_URL @ $GUEST_REPO_REF"
		mkdir -p "$(dirname "$GUEST_VENDOR_ROOT")"
		if [[ -d "$GUEST_VENDOR_ROOT/.git" ]]; then
			git -C "$GUEST_VENDOR_ROOT" fetch --depth 1 origin "$GUEST_REPO_REF"
			git -C "$GUEST_VENDOR_ROOT" checkout --force FETCH_HEAD
		else
			rm -rf "$GUEST_VENDOR_ROOT"
			git clone --depth 1 --branch "$GUEST_REPO_REF" "$GUEST_REPO_URL" "$GUEST_VENDOR_ROOT"
		fi
	fi

	export GONDOLIN_GUEST_SRC="$GUEST_DIR"
fi

if [[ ! -f "${GONDOLIN_GUEST_SRC}/build.zig" ]]; then
	echo "GONDOLIN_GUEST_SRC is invalid (missing build.zig): ${GONDOLIN_GUEST_SRC}" >&2
	exit 1
fi

mkdir -p "$OUTPUT_DIR"
mkdir -p "$(dirname "$LOCK_PATH")"

echo "[gondolin-image] config: $CONFIG_PATH"
echo "[gondolin-image] output: $OUTPUT_DIR"
echo "[gondolin-image] lock: $LOCK_PATH"
echo "[gondolin-image] version: $IMAGE_VERSION"
echo "[gondolin-image] guest source: $GONDOLIN_GUEST_SRC"

(
	cd "$PI_EVAL_DIR"
	bunx @earendil-works/gondolin build --config "$CONFIG_PATH" --output "$OUTPUT_DIR"
	bunx @earendil-works/gondolin build --verify "$OUTPUT_DIR"
)

bun "$ROOT_DIR/skills-evals/gondolin/scripts/write-image-lock.ts" \
	--image-dir "$OUTPUT_DIR" \
	--lock-file "$LOCK_PATH" \
	--config-file "$CONFIG_PATH" \
	--project-root "$ROOT_DIR" \
	--version "$IMAGE_VERSION" \
	--pi-package-name "$PI_PACKAGE_NAME" \
	--pi-package-version "$PI_PACKAGE_VERSION"

echo "[gondolin-image] done."
echo "[gondolin-image] use with PI_EVAL_GONDOLIN_IMAGE_PATH=$OUTPUT_DIR"
