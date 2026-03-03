#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASES_DIR="$ROOT_DIR/skills-evals/fixtures/eval-cases"
REPORTS_DIR="$ROOT_DIR/skills-evals/reports"
GENERATED_DIR="$ROOT_DIR/skills-evals/generated"
PURGE_SCRIPT="$ROOT_DIR/skills-evals/pi-eval/src/cli/purge-report.ts"
LIST_SCRIPT="$ROOT_DIR/skills-evals/pi-eval/src/cli/list-cases.ts"
MANAGE_REMOVE_SCRIPT="$ROOT_DIR/skills-evals/pi-eval/src/cli/manage-remove.ts"

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

# slug_from_id / trace_file_name are now in pi-eval/src/cli/manage-remove.ts
# (canonical implementations: slugFromId in data/cases.ts, traceFileName in reporting/report-persistence.ts)

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

	# Resolve targets via TS (canonical slug/traceFileName from data layer)
	local targets_json
	targets_json="$(bun -e "
import { resolveRemoveTargets } from '$MANAGE_REMOVE_SCRIPT';
const targets = await resolveRemoveTargets('$case_id', {
  casesDir: '$CASES_DIR',
  reportsDir: '$REPORTS_DIR',
  generatedDir: '$GENERATED_DIR',
});
console.log(JSON.stringify(targets));
")"

	local is_bundle variant_tags_csv
	is_bundle="$(echo "$targets_json" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.isBundle ? '1' : '0')")"
	variant_tags_csv="$(echo "$targets_json" | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log(d.variantTags.join(','))")"

	# Read file/dir lists from JSON
	local -a files_to_delete=()
	local -a dirs_to_delete=()
	local -a purge_args=()
	while IFS= read -r f; do files_to_delete+=("$f"); done < <(echo "$targets_json" | bun -e "const d=JSON.parse(await Bun.stdin.text()); d.filesToDelete.forEach(f=>console.log(f))")
	while IFS= read -r d; do dirs_to_delete+=("$d"); done < <(echo "$targets_json" | bun -e "const d=JSON.parse(await Bun.stdin.text()); d.dirsToDelete.forEach(f=>console.log(f))")
	while IFS= read -r a; do purge_args+=("$a"); done < <(echo "$targets_json" | bun -e "const d=JSON.parse(await Bun.stdin.text()); d.purgeArgs.forEach(a=>console.log(a))")

	# Display plan
	echo "Case: $case_id ($([ "$is_bundle" == "1" ] && echo "bundle: $variant_tags_csv" || echo "standalone"))"
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
