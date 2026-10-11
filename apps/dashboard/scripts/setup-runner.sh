#!/usr/bin/env bash
# Fixed setup program. All path values are positional arguments, never eval'd.
set -euo pipefail
source_repo=$1
source_token=$2
port=$3
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo 'Invalid runner port.'; exit 1; }
[[ $(id -u) != 0 && -z ${SUDO_USER:-} ]] || { echo 'Run WSL as a regular user, without sudo.'; exit 1; }
grep -qi WSL2 /proc/sys/kernel/osrelease || { echo 'This launcher requires WSL2, not WSL1.'; exit 1; }
command -v node >/dev/null && command -v pnpm >/dev/null || { echo 'Install Linux Node.js 22.12+ and pnpm 10.33.0 in WSL once.'; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(process.platform!=="linux" || major<22 || major===22&&minor<12)process.exit(1)' || { echo 'Use Linux Node.js 22.12+; Windows Node.exe is unsupported.'; exit 1; }
[[ $(pnpm --version) == 10.33.0 ]] || { echo 'Use pnpm 10.33.0 in WSL.'; exit 1; }
docker info >/dev/null 2>&1 || echo 'Docker is inaccessible inside WSL. Runner readiness will disable Start until Docker is available.'
runtime_root="${XDG_DATA_HOME:-$HOME/.local/share}/astra-dashboard"
mkdir -p "$runtime_root"
chmod 700 "$runtime_root"
runtime_repo="$runtime_root/source"
mkdir -p "$runtime_repo"
# Separate Linux dependency tree preserves the existing Windows checkout and CLI.
tar -C "$source_repo" --exclude='./.git' --exclude='./.tools' --exclude='./node_modules' --exclude='*/node_modules' --exclude='*/dist' --exclude='./.astra-dashboard' --exclude='./workspaces' -cf - . | tar -C "$runtime_repo" -xf -
cp "$source_token" "$runtime_root/runner-token"
chmod 600 "$runtime_root/runner-token"
[[ ! -f "$runtime_repo/.env" ]] || chmod 600 "$runtime_repo/.env"
cd "$runtime_repo"
pnpm install --frozen-lockfile
pnpm dashboard:build
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({source:process.cwd(),workspace:process.argv[2],port:Number(process.argv[3])}))' "$runtime_root/paths.json" "$runtime_root/workspaces" "$port"
if [[ ! -f "$runtime_root/settings.json" ]]; then
  node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({repositoryRoots:[process.cwd()],allowedPrivateHosts:[]},null,2),{mode:0o600})' "$runtime_root/settings.json"
fi
printf 'ASTRA_RUNNER_DESCRIPTOR='
cat "$runtime_root/paths.json"
printf '\n'
