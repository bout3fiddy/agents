#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_PATH="$ROOT_DIR/skills-evals/pi-eval/index.ts"
MODELS_FILE_DEFAULT="$ROOT_DIR/skills-evals/fixtures/models.jsonl"
DEFAULT_GONDOLIN_IMAGE_PATH="$ROOT_DIR/skills-evals/gondolin/image/current"
CASE_FILTER=""

usage() {
	cat <<'EOF'
Usage: skills-evals/run.sh [--case CASE_ID]

Options:
  --case CASE_ID   Run only the matching case ID (applies --filter CASE_ID --limit 1)
  -h, --help       Show this help message
EOF
}

while [[ "$#" -gt 0 ]]; do
	case "$1" in
	--case)
		if [[ "$#" -lt 2 || -z "${2//[[:space:]]/}" ]]; then
			echo "--case requires a non-empty case ID." >&2
			usage >&2
			exit 1
		fi
		CASE_FILTER="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if ! command -v pi >/dev/null 2>&1; then
	echo "pi is not installed or not on PATH." >&2
	exit 1
fi

if [[ -z "${PI_EVAL_GONDOLIN_IMAGE_PATH:-}" ]]; then
	export PI_EVAL_GONDOLIN_IMAGE_PATH="$DEFAULT_GONDOLIN_IMAGE_PATH"
fi

if [[ ! -d "${PI_EVAL_GONDOLIN_IMAGE_PATH}" ]]; then
	echo "Gondolin image directory not found: ${PI_EVAL_GONDOLIN_IMAGE_PATH}" >&2
	echo "Build it with ./skills-evals/gondolin/scripts/build-image.sh or set PI_EVAL_GONDOLIN_IMAGE_PATH." >&2
	exit 1
fi

if [[ ! -f "${PI_EVAL_GONDOLIN_IMAGE_PATH}/manifest.json" ]]; then
	echo "Gondolin image directory is missing manifest.json: ${PI_EVAL_GONDOLIN_IMAGE_PATH}/manifest.json" >&2
	echo "Build it with ./skills-evals/gondolin/scripts/build-image.sh or set PI_EVAL_GONDOLIN_IMAGE_PATH." >&2
	exit 1
fi

cd "$ROOT_DIR"

if [[ -z "${NO_COLOR:-}" ]]; then
	export FORCE_COLOR="${FORCE_COLOR:-1}"
fi

if [[ -z "${PI_EVAL_TABLE_WIDTH:-}" ]]; then
	if [[ -n "${COLUMNS:-}" ]]; then
		export PI_EVAL_TABLE_WIDTH="$COLUMNS"
	elif [[ -t 0 ]] && command -v stty >/dev/null 2>&1; then
		TABLE_WIDTH="$(stty size </dev/tty 2>/dev/null | awk '{print $2}')"
		if [[ -n "$TABLE_WIDTH" ]]; then
			export PI_EVAL_TABLE_WIDTH="$TABLE_WIDTH"
		fi
	elif [[ -t 0 ]] && command -v tput >/dev/null 2>&1; then
		TABLE_WIDTH="$(tput cols 2>/dev/null || true)"
		if [[ -n "$TABLE_WIDTH" ]]; then
			export PI_EVAL_TABLE_WIDTH="$TABLE_WIDTH"
		fi
	fi
fi

MODEL_SPECS=()
MODELS_FILE="${PI_EVAL_MODELS_FILE:-$MODELS_FILE_DEFAULT}"
THINKING_DEFAULT="${PI_EVAL_THINKING:-low}"

LOG_DIR="${PI_EVAL_LOG_DIR:-$ROOT_DIR/skills-evals/logs}"
LOG_PATH="${PI_EVAL_LOG:-}"
LOG_OFF=0
if [[ "$LOG_PATH" == "off" || "$LOG_PATH" == "0" ]]; then
	LOG_OFF=1
fi
RUN_STAMP="$(date +"%Y-%m-%d_%H-%M-%S")"

safe_model_name() {
	printf "%s" "$1" | sed -E 's/[^a-zA-Z0-9._-]+/-/g'
}

load_models() {
	if [[ ! -f "$MODELS_FILE" ]]; then
		echo "Models file not found: $MODELS_FILE" >&2
		exit 1
	fi

	MODEL_SPECS=()
	local line_no=0
	local line model thinking judge_model judge_thinking
	while IFS= read -r line || [[ -n "$line" ]]; do
		line_no=$((line_no + 1))
		if [[ -z "${line//[[:space:]]/}" ]]; then
			continue
		fi
		local parsed
		parsed="$(printf "%s\n" "$line" | python3 -c "
import sys, json
d = json.load(sys.stdin)
e = d.get('eval')
j = d.get('judge', {})
model = (e.get('model','') if isinstance(e,dict) else '') or d.get('model','')
thinking = (e.get('thinking','') if isinstance(e,dict) else '') or d.get('thinking','')
jm = j.get('model','') if isinstance(j,dict) else ('false' if j is False else '')
jt = j.get('thinking','') if isinstance(j,dict) else ''
print(f'{model}\t{thinking}\t{jm}\t{jt}')
" 2>/dev/null || echo "")"
		model="$(printf "%s" "$parsed" | cut -f1)"
		thinking="$(printf "%s" "$parsed" | cut -f2)"
		judge_model="$(printf "%s" "$parsed" | cut -f3)"
		judge_thinking="$(printf "%s" "$parsed" | cut -f4)"
		if [[ -z "$model" ]]; then
			echo "Invalid model entry in $MODELS_FILE:$line_no (expected {\"eval\":{\"model\":\"provider/model\"}})." >&2
			exit 1
		fi
		if [[ -z "$thinking" ]]; then
			thinking="$THINKING_DEFAULT"
		fi
		MODEL_SPECS+=("${model}|${thinking}|${judge_model}|${judge_thinking}")
	done <"$MODELS_FILE"

	if [[ "${#MODEL_SPECS[@]}" -eq 0 ]]; then
		echo "No models found in $MODELS_FILE" >&2
		exit 1
	fi
}

run_for_model() {
	local model="$1"
	local thinking="$2"
	local judge_model="${3:-}"
	local judge_thinking="${4:-}"
	local prompt="/eval run --thinking $thinking --model $model"
	if [[ -n "$CASE_FILTER" ]]; then
		prompt="$prompt --filter $CASE_FILTER --limit 1"
	fi

	local -a env_prefix=()
	if [[ -n "$judge_model" ]]; then
		env_prefix+=(PI_EVAL_JUDGE_MODEL="$judge_model")
	fi
	if [[ -n "$judge_thinking" ]]; then
		env_prefix+=(PI_EVAL_JUDGE_THINKING="$judge_thinking")
	fi

	if ((LOG_OFF == 0)); then
		local run_log
		if [[ -n "$LOG_PATH" && "${#MODEL_SPECS[@]}" -eq 1 ]]; then
			run_log="$LOG_PATH"
		else
			run_log="$LOG_DIR/$RUN_STAMP/$(safe_model_name "$model").log"
		fi
		mkdir -p "$(dirname "$run_log")"
		echo "[$model] Logging to $run_log"
		env "${env_prefix[@]}" pi --no-session --no-extensions -e "$EXT_PATH" -p "$prompt" 2>&1 | tee "$run_log"
		return
	fi

	env "${env_prefix[@]}" pi --no-session --no-extensions -e "$EXT_PATH" -p "$prompt"
}

wait_for_pids() {
	local pid
	local failed_local=0
	for pid in "$@"; do
		if ! wait "$pid"; then
			failed_local=1
		fi
	done
	return "$failed_local"
}

load_models
MAX_PARALLEL="${PI_EVAL_MAX_PARALLEL:-${#MODEL_SPECS[@]}}"
if ! [[ "$MAX_PARALLEL" =~ ^[0-9]+$ ]] || ((MAX_PARALLEL < 1)); then
	echo "PI_EVAL_MAX_PARALLEL must be a positive integer." >&2
	exit 1
fi

echo "Running ${#MODEL_SPECS[@]} model(s); max parallel=$MAX_PARALLEL"
echo "Models source: $MODELS_FILE"
if [[ -n "$CASE_FILTER" ]]; then
	echo "Case filter: $CASE_FILTER (limit=1)"
fi

failed=0
PIDS=()
for spec in "${MODEL_SPECS[@]}"; do
	model="${spec%%|*}"
	remainder="${spec#*|}"
	thinking="${remainder%%|*}"
	remainder="${remainder#*|}"
	judge_model="${remainder%%|*}"
	judge_thinking="${remainder#*|}"
	echo "[$model] Starting (thinking=$thinking)"
	run_for_model "$model" "$thinking" "$judge_model" "$judge_thinking" &
	PIDS+=("$!")
	if ((${#PIDS[@]} >= MAX_PARALLEL)); then
		if ! wait_for_pids "${PIDS[@]}"; then
			failed=1
		fi
		PIDS=()
	fi
done

if ((${#PIDS[@]} > 0)); then
	if ! wait_for_pids "${PIDS[@]}"; then
		failed=1
	fi
fi

if ((failed != 0)); then
	echo "One or more eval runs failed." >&2
	exit 1
fi
