#!/usr/bin/env bash
#
# Sample script to run the server under bwrap.
#
set -eu

DIR=$(dirname "$0")
cd "$DIR"

ARGS=()
CACHE_DIR=""
ROOT_DIRS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bind|--port)
            if [[ $# -lt 2 ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            ARGS+=("$1" "$2")
            shift 2
            ;;
        --cache-dir)
            if [[ $# -lt 2 ]]; then
                echo "Error: --cache-dir requires a value" >&2
                exit 1
            fi
            CACHE_DIR="$(realpath "$2")"
            ARGS+=("$1" "$2")
            shift 2
            ;;
        --cache-dir=*)
            CACHE_DIR="$(realpath "${1#*=}")"
            ARGS+=("$1")
            shift
            ;;
        --*)
            echo "Error: unknown option $1" >&2
            exit 1
            ;;
        *)
            if [[ -d "$1" ]]; then
                ROOT_DIRS+=("$(realpath "$1")")
            else
                echo "Error: not a directory: $1" >&2
                exit 1
            fi
            ARGS+=("$1")
            shift
            ;;
    esac
done

if ! command -v bwrap >/dev/null ; then
    echo "missing bwrap" >&2
    exit 1
fi

if ! command -v uv >/dev/null ; then
    echo "missing uv" >&2
    exit 1
fi

if [[ -z "$CACHE_DIR" ]]; then
    CACHE_DIR="$HOME/.cache/media_browser_cache"
fi

mkdir -p "$HOME/.local/share/uv"
mkdir -p "$DIR/.venv"
mkdir -p "$CACHE_DIR"

BWRAP_ARGS=(
    --ro-bind-try /bin /bin
    --ro-bind /usr /usr
    --ro-bind /lib /lib
    --ro-bind-try /lib64 /lib64
    --ro-bind /etc /etc
    --proc /proc
    --dev-bind /dev /dev
    --tmpfs /tmp

    --ro-bind "$DIR" /app
    --bind "$HOME/.local/share/uv" "$HOME/.local/share/uv"
    --bind "$DIR/.venv" /app/.venv
    --bind "$CACHE_DIR" "$CACHE_DIR"
)

# Mount root directories read-only
for d in "${ROOT_DIRS[@]}"; do
    BWRAP_ARGS+=(--ro-bind "$d" "$d")
done

exec bwrap "${BWRAP_ARGS[@]}" /app/run.sh "${ARGS[@]}"
