#!/usr/bin/env bash
set -euo pipefail
repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
runtime_root=$(dirname -- "$repository_root")
port=$1
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo 'Invalid runner port.'; exit 1; }
cd "$repository_root"
export ASTRA_DASHBOARD_PORT="$port"
export ASTRA_DASHBOARD_RUNNER_TOKEN_FILE="$runtime_root/runner-token"
export ASTRA_DASHBOARD_SETTINGS_FILE="$runtime_root/settings.json"
export ASTRA_WORKSPACES_DIR="$runtime_root/workspaces"
export ASTRA_DASHBOARD_CONTROL_DIR="$runtime_root/control"
unset ASTRA_DASHBOARD_RUNNER_URL ASTRA_DASHBOARD_REPO_ROOTS
exec node apps/dashboard/dist/server/index.js
