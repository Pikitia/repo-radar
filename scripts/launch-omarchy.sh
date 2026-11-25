#!/usr/bin/bash
set -euo pipefail

install_root=$(dirname -- "$(realpath -- "$0")")
# Pin this release before the installer can retire it. Keep the lock in the
# launcher process and close it in Electron and its children.
exec 9<"$install_root/activation.lock"
flock --shared 9
release=$(realpath -e -- "$install_root/current")
exec 8<"$release"
flock --shared 8
exec 9<&-
"$release/repo-radar" "$@" 8<&-
