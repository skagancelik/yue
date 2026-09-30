#!/bin/bash
# One-time (idempotent) GPU box preparation. Called by agent.py as root.
# Exit code 100 = reboot required (after NVIDIA driver install).
set -euo pipefail

TURBO_REPO=https://github.com/NoizAI/YuE2-Turbo.git
TURBO_REF=7c88813bfff9db9127f11c35b9e1b72983ded200   # pinned, bump deliberately
NVIDIA_DRIVER=580-server-open
MODELS="m-a-p/YuE2-3B m-a-p/YuE2-Vae m-a-p/SheetSage2 m-a-p/MERT-v2-FullSong"

YUE=/opt/yue
export HF_HOME=$YUE/hf
export DEBIAN_FRONTEND=noninteractive
step() { echo "::step:: $*"; }

# 1. NVIDIA driver (L4/A10G/L40S all support the open kernel modules).
if ! nvidia-smi >/dev/null 2>&1; then
  step "NVIDIA sürücüsü kuruluyor"
  apt-get update -q
  # Prebuilt signed modules for the running AWS kernel; DKMS build as fallback.
  apt-get install -y -q "linux-modules-nvidia-${NVIDIA_DRIVER}-$(uname -r)" "nvidia-utils-${NVIDIA_DRIVER%-open}" \
       "libnvidia-compute-${NVIDIA_DRIVER%-open}" \
    || apt-get install -y -q "linux-headers-$(uname -r)" "nvidia-headless-${NVIDIA_DRIVER}" "nvidia-utils-${NVIDIA_DRIVER%-open}"
  # Keep kernel/driver stable: nothing should upgrade them behind our back.
  systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
  exit 100
fi
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

# Triton (torch.compile inside vLLM) builds small C helpers at startup.
if ! command -v gcc >/dev/null || [ ! -f /usr/include/python3.12/Python.h ]; then
  step "Derleyici kuruluyor"
  apt-get update -q
  apt-get install -y -q build-essential python3-dev
fi

# 2. uv + Python 3.12 + YuE2-Turbo (vLLM path) at a pinned commit.
if ! command -v uv >/dev/null && [ ! -x /usr/local/bin/uv ]; then
  step "uv kuruluyor"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
fi
export PATH=/usr/local/bin:$PATH

if [ "$(cat $YUE/turbo/.installed 2>/dev/null)" != "$TURBO_REF" ]; then
  step "YuE2-Turbo kuruluyor (torch + vLLM, ~6 GB)"
  rm -rf $YUE/turbo
  git clone -q $TURBO_REPO $YUE/turbo
  git -C $YUE/turbo checkout -q $TURBO_REF
  cd $YUE/turbo
  uv venv -q --python 3.12 .venv
  UV_CACHE_DIR=$YUE/uv-cache uv pip install -q --python .venv/bin/python torch==2.10.0 \
    --index-url https://download.pytorch.org/whl/cu128
  UV_CACHE_DIR=$YUE/uv-cache uv pip install -q --python .venv/bin/python '.[server]'
  rm -rf $YUE/uv-cache
  echo $TURBO_REF > $YUE/turbo/.installed
fi

# 3. Model weights into the HF cache on the (persistent) root volume.
if [ ! -f $YUE/hf/.models-ok ]; then
  step "Model dosyaları indiriliyor (~10.6 GB)"
  mkdir -p $YUE/hf
  for model in $MODELS; do
    $YUE/turbo/.venv/bin/huggingface-cli download "$model" >/dev/null
  done
  touch $YUE/hf/.models-ok
fi

mkdir -p $YUE/data $YUE/work
if [ ! -f $YUE/secret.env ]; then
  echo "YUE2_API_KEY=$(openssl rand -hex 32)" > $YUE/secret.env
  chmod 600 $YUE/secret.env
fi
step "Kurulum tamam"
