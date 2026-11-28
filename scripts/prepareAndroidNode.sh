#!/usr/bin/env bash
set -euo pipefail

# Использует закреплённый сборщик Bionic из GrigDesk и добавляет поддержку ресурса SEA.
# Кэш CI хранит только готовый Node, исходные архивы сверяются перед сборкой.
grigdesk=${1:?Укажите checkout GrigDesk}
abi=${2:?Укажите ABI Android}
scratch=${3:?Укажите рабочую папку}
root=$(cd "$(dirname "$0")/.." && pwd)
lock="$grigdesk/tools/android/ndk.lock.json"

mkdir -p "$scratch"

fetch_checked() {
  local url=$1 expected=$2 file=$3

  if ! sha256sum --check --status <<<"$expected  $file" 2>/dev/null; then
    curl --fail --location --retry 3 --output "$file.part" "$url"
    sha256sum --check <<<"$expected  $file.part"
    mv "$file.part" "$file"
  fi
}

node_archive="$scratch/node.tar.xz"
ndk_archive="$scratch/ndk.zip"
ndk="$scratch/android-ndk-$(jq -er .ndkVersion "$lock")"

fetch_checked "$(jq -er .ndkUrl "$lock")" "$(jq -er .ndkSha256 "$lock")" "$ndk_archive"
if [[ ! -d "$ndk" ]]; then
  unzip -q "$ndk_archive" -d "$scratch"
fi

if [[ ! -s "$scratch/out/$abi/libnode.so" || ! -s "$scratch/out/$abi/LICENSE" ]]; then
  fetch_checked "$(jq -er .nodeSourceUrl "$lock")" "$(jq -er .nodeSourceSha256 "$lock")" "$node_archive"
  source=$(mktemp -d "$scratch/node-source.XXXXXX")
  trap 'rm -rf -- "$source"' EXIT
  tar -xJf "$node_archive" -C "$source" --strip-components=1
  git -C "$source" apply "$root/build/android/node-sea.patch"

  node "$grigdesk/tools/android/node-bionic.mts" --abi "$abi" --ndk-dir "$ndk" \
    --source-dir "$source" --out-dir "$scratch/out" --jobs "$(nproc)" \
    --node-archive "$node_archive" --ndk-archive "$ndk_archive"

  cp "$source/LICENSE" "$scratch/out/$abi/LICENSE"
fi
