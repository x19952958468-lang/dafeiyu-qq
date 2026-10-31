#!/bin/sh
# Foreground launcher; Node owns this process group and the heavy-work lock.
set -eu
REPOSITORY=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DAFEIYU_WORK_DIR=${DAFEIYU_WORK_DIR:-"$REPOSITORY/work"}
case "$DAFEIYU_WORK_DIR" in /*) ;; *) DAFEIYU_WORK_DIR="$PWD/$DAFEIYU_WORK_DIR" ;; esac
BREEZE_SOURCE_DIR=${BREEZE_SOURCE_DIR:-"$DAFEIYU_WORK_DIR/breeze-tts"}
BREEZE_PYTHON=${BREEZE_PYTHON:-"$DAFEIYU_WORK_DIR/breeze-venv/bin/python"}
BREEZE_MODELS_DIR=${BREEZE_MODELS_DIR:-"$DAFEIYU_WORK_DIR/breeze-models"}
case "$BREEZE_SOURCE_DIR" in /*) ;; *) BREEZE_SOURCE_DIR="$PWD/$BREEZE_SOURCE_DIR" ;; esac
case "$BREEZE_MODELS_DIR" in /*) ;; *) BREEZE_MODELS_DIR="$PWD/$BREEZE_MODELS_DIR" ;; esac
case "$BREEZE_PYTHON" in /*) ;; */*) BREEZE_PYTHON="$PWD/$BREEZE_PYTHON" ;; esac
case "${BREEZE_LOCAL_VARIANT-8bit}" in
  8bit|mixed) BREEZE_MODEL_DIR="$BREEZE_MODELS_DIR/${BREEZE_LOCAL_VARIANT-8bit}" ;;
  *) echo 'Unsupported speech backend variant' >&2; exit 2 ;;
esac
cd "$BREEZE_SOURCE_DIR"
export PYTHONUNBUFFERED=1
export TOKENIZERS_PARALLELISM=false
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export BREEZE_MLX_CACHE_GB=${BREEZE_MLX_CACHE_GB:-1}
unset BREEZE_MLX_QUANT
exec "$BREEZE_PYTHON" -m breeze_infer.api \
  "$BREEZE_MODEL_DIR" \
  --backend mlx --host 127.0.0.1 --port "${BREEZE_PORT:-6197}" --ws-port disabled \
  --voices-dir "$BREEZE_MODELS_DIR/voices" \
  --chunk-first 1 --chunk-max 25
