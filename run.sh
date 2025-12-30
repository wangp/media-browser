#!/bin/sh
set -eu

DIR=$(dirname "$0")
cd "$DIR"

if ! command -v uv >/dev/null ; then
    echo "missing uv" >&2
    exit 1
fi

exec uv run media_browser.py "$@"
