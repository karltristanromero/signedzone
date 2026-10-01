#!/usr/bin/env bash
# Always runs the app with the project-local virtualenv, so the correct
# dependencies (click, python-multipart, pymupdf, ...) are guaranteed
# regardless of which python/conda/pyenv is active in your shell.
set -euo pipefail

cd "$(dirname "$0")"

VENV_PY=".venv/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "Creating virtualenv..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi

echo "Using: $($VENV_PY -V) at $(pwd)/.venv"
exec "$VENV_PY" -m uvicorn app:app --host 127.0.0.1 --port "${PORT:-8000}" "$@"
