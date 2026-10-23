#!/bin/sh
# Lays out the Lambda package in Cloud/.build (template.yaml's CodeUri): the handler, the two
# Engine modules it reuses unchanged (prompt schema and Claude provider), and this folder's
# pinned manifest, which `sam build` installs with npm ci. Run before every `sam build`.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/.build"
rm -rf "$out"
mkdir -p "$out/Cloud" "$out/Engine"
cp "$here/handler.mjs" "$here/license.mjs" "$here/lambda.mjs" "$out/Cloud/"
cp "$here/../Engine/ai.mjs" "$here/../Engine/claude.mjs" "$out/Engine/"
cp "$here/package.json" "$here/package-lock.json" "$out/"
echo "Staged $out"
