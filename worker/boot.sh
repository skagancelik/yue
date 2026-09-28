#!/bin/bash
# Runs as root on every boot (from EC2 user-data) after the repo is pulled.
# Keeps boot light: only makes sure the agent's own deps exist, then hands off
# to the yue-agent systemd service, which does setup / model serving / jobs.
set -euo pipefail
APP=/opt/yue/app

if ! python3 -c "import boto3, requests" 2>/dev/null || ! command -v ffmpeg >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q python3-boto3 python3-requests ffmpeg git curl jq
fi

install -m 644 $APP/worker/yue-agent.service /etc/systemd/system/yue-agent.service
install -m 644 $APP/worker/yue2-serve.service /etc/systemd/system/yue2-serve.service
systemctl daemon-reload
systemctl enable yue-agent.service >/dev/null 2>&1 || true
systemctl restart yue-agent.service
