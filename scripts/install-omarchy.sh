#!/usr/bin/bash
set -euo pipefail

if [[ $(uname -s) != Linux || $EUID == 0 ]]; then
  echo 'Run this command as your desktop user on Linux.' >&2
  exit 1
fi

cd -- "$(dirname -- "$0")/.."
source_directory=$(pwd -P)
data_home=$(realpath -m -- "${XDG_DATA_HOME:-$HOME/.local/share}")
install_root=$data_home/repo-radar
desktop_directory=$data_home/applications
mkdir -p -- release "$install_root/versions" "$desktop_directory"
exec 9>"$install_root/build.lock"
exec 8>release/.omarchy-build.lock
if ! flock --nonblock 9 || ! flock --nonblock 8; then
  echo 'A Repo Radar installation or update is already running.' >&2
  exit 1
fi

# Reinstall from the lockfile on the first build or whenever dependencies change.
lock_digest=$(sha256sum < package-lock.json)
if [[ ! -x node_modules/.bin/electron-builder || ! -f node_modules/.repo-radar-lock || $(<node_modules/.repo-radar-lock) != "$lock_digest" ]]; then
  npm ci --prefer-offline --no-audit --no-fund
  printf '%s\n' "$lock_digest" > node_modules/.repo-radar-lock
fi
npm run build
npm exec -- electron-builder --linux dir --publish never --config.npmRebuild=false

arch=$(node -p 'process.arch')
build_directory=release/linux-unpacked
[[ $arch == x64 ]] || build_directory=release/linux-$arch-unpacked

stage=$(mktemp -d -- "$install_root/.build.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
release_name=build.${stage##*.}
next_release=versions/$release_name
cp -a -- "$build_directory" "$stage/app"
install -m755 -- scripts/launch-omarchy.sh "$stage/launch"
install -m644 -- assets/icon.svg "$stage/icon.svg"

node --input-type=module - "$stage" "$source_directory" "$data_home" "$install_root" <<'NODE'
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [stage, sourceDirectory, dataHome, installRoot] = process.argv.slice(2);
const launcher = path.join(installRoot, 'launch');
writeFileSync(path.join(stage, 'app', 'resources', 'repo-radar-install.json'), JSON.stringify({
  sourceDirectory, dataHome, launcher, node: process.execPath, npm: process.env.npm_execpath
}));

const desktopValue = value => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
const execArgument = value => desktopValue('"' + value.replace(/["`$\\]/g, '\\$&').replaceAll('%', '%%') + '"');
writeFileSync(path.join(stage, 'repo-radar.desktop'), `[Desktop Entry]
Type=Application
Name=Repo Radar
Comment=Monitor Git status across local repositories
Exec=${execArgument(launcher)}
Icon=${desktopValue(path.join(installRoot, 'icon.svg'))}
Terminal=false
StartupWMClass=repo-radar
Categories=Development;
`);
NODE

if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$stage/repo-radar.desktop"
fi
exec 7>"$install_root/activation.lock"
flock 7
previous=$(readlink -- "$install_root/current" || true)
mv -T -- "$stage/app" "$install_root/$next_release"
mv -T -- "$stage/launch" "$install_root/launch"
mv -T -- "$stage/icon.svg" "$install_root/icon.svg"
ln -s -- "$next_release" "$stage/current"
mv -T -- "$stage/repo-radar.desktop" "$desktop_directory/repo-radar.desktop"
mv -Tf -- "$stage/current" "$install_root/current"

# Keep the prior build and any older release with a window still open.
for release in "$install_root"/versions/build.*; do
  [[ $release == "$install_root/$next_release" || $release == "$install_root/$previous" ]] && continue
  flock --nonblock "$release" rm -rf -- "$release" || true
done
echo 'Repo Radar is installed. Open it from the app launcher.'
