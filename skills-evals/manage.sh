#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASES_DIR="$ROOT_DIR/skills-evals/fixtures/eval-cases"
REPORTS_DIR="$ROOT_DIR/skills-evals/reports"
GENERATED_DIR="$ROOT_DIR/skills-evals/generated"
PURGE_SCRIPT="$ROOT_DIR/skills-evals/pi-eval/src/cli/purge-report.ts"
LIST_SCRIPT="$ROOT_DIR/skills-evals/pi-eval/src/cli/list-cases.ts"

usage() {
	cat <<'EOF'
Usage: skills-evals/manage.sh <command> [options]

Commands:
  list                        List all defined eval cases
  remove --case CASE_ID       Remove an eval case and all its artifacts
                              [--dry-run]  Show what would be deleted
                              [--yes]      Skip confirmation prompt
EOF
}

# Must match slugFromId in pi-eval/src/data/cases.ts
slug_from_id() {
	printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9'
}

# Must match traceFileName in pi-eval/src/reporting/report-persistence.ts
# (replace colons with --, then apply toSafePathSegment sanitization)
trace_file_name() {
	local name="$1"
	# Replace colons with double-dash (matches traceFileName `:` -> `--`)
	name="${name//:/--}"
	# Apply toSafePathSegment: replace non-safe chars with -, collapse separators, trim edges
	name="$(printf '%s' "$name" | sed -E 's/[^a-zA-Z0-9._-]+/-/g; s/[-._]{2,}/-/g; s/^-+//; s/-+$//')"
	printf '%s' "${name:-case}"
}

cmd_list() {
	bun run "$LIST_SCRIPT" --cases-dir "$CASES_DIR"
}

cmd_remove() {
	local case_id="" dry_run=0 skip_confirm=0

	while [[ "$#" -gt 0 ]]; do
		case "$1" in
		--case)
			[[ "$#" -lt 2 || -z "${2//[[:space:]]/}" ]] && { echo "--case requires a non-empty case ID." >&2; exit 1; }
			case_id="$2"; shift 2 ;;
		--dry-run) dry_run=1; shift ;;
		--yes) skip_confirm=1; shift ;;
		*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
		esac
	done

	if [[ -z "$case_id" ]]; then
		echo "Error: --case CASE_ID is required." >&2
		usage >&2
		exit 1
	fi

	# Strict case-id validation: only allow alphanumeric, dash, underscore, dot, colon
	if [[ ! "$case_id" =~ ^[a-zA-Z0-9._:-]+$ ]]; then
		echo "Error: invalid case ID (must match [a-zA-Z0-9._:-]+): $case_id" >&2
		exit 1
	fi

	local jsonl_path="$CASES_DIR/${case_id}.jsonl"
	# Verify resolved path is inside CASES_DIR to prevent traversal
	local resolved_jsonl
	resolved_jsonl="$(cd "$CASES_DIR" 2>/dev/null && realpath -m "${case_id}.jsonl" 2>/dev/null || echo "")"
	if [[ -z "$resolved_jsonl" || "$resolved_jsonl" != "$CASES_DIR"/* ]]; then
		echo "Error: case ID resolves outside cases dir: $case_id" >&2
		exit 1
	fi
	if [[ ! -f "$jsonl_path" ]]; then
		echo "Error: Case file not found: $jsonl_path" >&2
		exit 1
	fi

	# Detect bundle vs standalone and extract metadata via bun
	local is_bundle=0 suite="" variant_tags=""
	local parsed
	parsed="$(bun -e "
const d = JSON.parse(await Bun.file('$jsonl_path').text());
const variants = Array.isArray(d.variants) ? d.variants : [];
const tags = variants.map(v => v.tag || '').filter(Boolean).join(',');
console.log([tags ? '1' : '0', d.suite || '', tags].join('\t'));
")"

	is_bundle="$(echo "$parsed" | cut -f1)"
	suite="$(echo "$parsed" | cut -f2)"
	variant_tags="$(echo "$parsed" | cut -f3)"

	local slug
	slug="$(slug_from_id "$case_id")"

	# Build deletion list
	local files_to_delete=()
	local dirs_to_delete=()

	# 1. JSONL definition
	files_to_delete+=("$jsonl_path")

	# 2. Routing traces — use trace_file_name to match report-persistence.ts naming
	if [[ "$is_bundle" == "1" ]]; then
		IFS=',' read -ra tags <<< "$variant_tags"
		for model_dir in "$REPORTS_DIR/routing-traces"/*/; do
			for tag in "${tags[@]}"; do
				local variant_trace
				variant_trace="$(trace_file_name "${case_id}:${tag}")"
				files_to_delete+=("${model_dir}${variant_trace}.json")
			done
			local verdict_trace
			verdict_trace="$(trace_file_name "${case_id}")--verdict"
			files_to_delete+=("${model_dir}${verdict_trace}.json")
		done
	else
		for model_dir in "$REPORTS_DIR/routing-traces"/*/; do
			local standalone_trace
			standalone_trace="$(trace_file_name "${case_id}")"
			files_to_delete+=("${model_dir}${standalone_trace}.json")
		done
	fi

	# 3. Generated artifacts (bundle only) — validate suite/slug before constructing path
	if [[ "$is_bundle" == "1" && -n "$suite" && -n "$slug" && -d "$GENERATED_DIR/$suite/$slug" ]]; then
		dirs_to_delete+=("$GENERATED_DIR/$suite/$slug")
	fi

	# Build purge args once; conditionally append --dry-run below
	local purge_args=("--case" "$case_id" "--reports-dir" "$REPORTS_DIR")
	[[ "$is_bundle" == "1" ]] && purge_args+=("--variants" "$variant_tags")

	# Display plan
	echo "Case: $case_id ($([ "$is_bundle" == "1" ] && echo "bundle: $variant_tags" || echo "standalone"))"
	echo ""
	echo "Files to delete:"
	for f in "${files_to_delete[@]}"; do
		echo "  rm $f"
	done
	if ((${#dirs_to_delete[@]})); then
		for d in "${dirs_to_delete[@]}"; do
			echo "  rm -r $d"
		done
	fi
	echo ""
	echo "Report purge: remove matching rows/sections from $REPORTS_DIR/*.md"

	if ((dry_run)); then
		echo ""
		echo "[dry-run] No files deleted."
		bun run "$PURGE_SCRIPT" "${purge_args[@]}" "--dry-run"
		return 0
	fi

	# Confirm
	if ((! skip_confirm)); then
		printf "Proceed? [y/N] "
		read -r answer
		if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
			echo "Aborted."
			return 1
		fi
	fi

	# Execute deletions — verify each target is under an expected root
	for f in "${files_to_delete[@]}"; do
		case "$f" in
			"$CASES_DIR"/*|"$REPORTS_DIR"/*) ;;
			*) echo "Error: delete target outside managed dirs: $f" >&2; exit 1 ;;
		esac
		rm -f "$f"
		echo "Deleted: $f"
	done
	if ((${#dirs_to_delete[@]})); then
		for d in "${dirs_to_delete[@]}"; do
			case "$d" in
				"$GENERATED_DIR"/*) ;;
				*) echo "Error: delete target outside managed dirs: $d" >&2; exit 1 ;;
			esac
			rm -rf "$d"
			echo "Deleted: $d"
		done
	fi

	# Purge reports
	bun run "$PURGE_SCRIPT" "${purge_args[@]}"

	echo ""
	echo "Done. Case $case_id removed."
}

# --- Main dispatch ---
if [[ "$#" -eq 0 ]]; then
	usage
	exit 1
fi

command="$1"; shift
case "$command" in
	list) cmd_list ;;
	remove) cmd_remove "$@" ;;
	-h|--help) usage ;;
	*) echo "Unknown command: $command" >&2; usage >&2; exit 1 ;;
esac
