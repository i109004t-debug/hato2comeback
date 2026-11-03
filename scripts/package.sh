#!/usr/bin/env bash
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/common.sh"
# 古いファイルを混入させない。削除先はリポジトリ内の固定パスだけ。
[[ $ROOT == "$(pwd -P)" && -d "$ROOT/src" && ! -L "$ROOT/build" && ! -L "$ROOT/build/backend" ]] || die 'Unsafe backend directory'
rm -rf -- "$ROOT/build/backend"
mkdir -p build/backend
cp -R src build/backend/src
cp package.json build/backend/package.json
printf 'Prepared build/backend/; cloudformation package will archive and upload it.\n'
