#!/bin/bash
# Vocal/instrumental separation (BS-RoFormer via audio-separator) in its own venv.
# Called by setup.sh; a failure here must not stop cover generation, so setup.sh
# runs this as a separate process and only warns when it fails.
set -euo pipefail

SEPARATOR_VERSION=0.47.0                                   # pinned, bump deliberately
SEPARATOR_MODEL=model_bs_roformer_ep_317_sdr_12.9755.ckpt  # keep in sync with agent.py
YUE=/opt/yue
SEP=$YUE/sep
export PATH=/usr/local/bin:$PATH

if [ "$(cat $SEP/.installed 2>/dev/null)" = "$SEPARATOR_VERSION" ]; then
  exit 0
fi
# After a failed install, retry at most once a day instead of on every boot.
if [ -f $SEP/.failed ] && [ $(( $(date +%s) - $(stat -c %Y $SEP/.failed) )) -lt 86400 ]; then
  echo "separator install failed recently; skipping (delete $SEP/.failed to retry now)"
  exit 1
fi
mkdir -p $SEP
trap 'touch $SEP/.failed' ERR

echo "::step:: Vokal ayırıcı kuruluyor"
rm -rf $SEP/.venv $SEP/.installed
mkdir -p $SEP/models
uv venv -q --python 3.12 $SEP/.venv
UV_CACHE_DIR=$YUE/uv-cache uv pip install -q --python $SEP/.venv/bin/python torch==2.10.0 torchaudio==2.10.0 \
  --index-url https://download.pytorch.org/whl/cu128
# audioread is imported by audio-separator but not declared as a dependency in 0.47.0.
UV_CACHE_DIR=$YUE/uv-cache uv pip install -q --python $SEP/.venv/bin/python \
  "audio-separator[gpu]==$SEPARATOR_VERSION" audioread
rm -rf $YUE/uv-cache
$SEP/.venv/bin/python -c "from audio_separator.separator import Separator"
$SEP/.venv/bin/audio-separator --model_file_dir $SEP/models -m $SEPARATOR_MODEL --download_model_only
echo $SEPARATOR_VERSION > $SEP/.installed
rm -f $SEP/.failed
