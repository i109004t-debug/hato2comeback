#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
ROOT=$(cd -- "${BASH_SOURCE[0]%/*}/.." && pwd)
cd -- "$ROOT"
mkdir -p build
# bash組込みだけで非圧縮ZIPを作る。ソースはUTF-8テキストでNULを含まない。
le() {
  local value=$1 count=$2 byte escaped
  while (( count > 0 )); do
    byte=$((value & 255))
    printf -v escaped '\\%03o' "$byte"
    printf '%b' "$escaped"
    value=$((value >> 8)); count=$((count - 1))
  done
}
declare -a CRC_TABLE=() FILES=() SIZES=() CRCS=() OFFSETS=()
for ((i=0; i<256; i++)); do
  c=$i
  for ((j=0; j<8; j++)); do
    if (( c & 1 )); then c=$(((c >> 1) ^ 0xedb88320)); else c=$((c >> 1)); fi
  done
  CRC_TABLE[i]=$c
done
shopt -s globstar nullglob
FILES=(package.json src/**/*.js)
(( ${#FILES[@]} > 1 )) || { printf 'Source files missing\n' >&2; exit 1; }
offset=0
exec 3>build/backend.zip
for file in "${FILES[@]}"; do
  size=0; crc=4294967295
  while IFS= read -r -N 1 char; do
    printf -v byte '%d' "'$char"
    crc=$(((crc >> 8) ^ CRC_TABLE[(crc ^ byte) & 255]))
    size=$((size + 1))
  done < "$file"
  crc=$((crc ^ 4294967295))
  SIZES+=("$size"); CRCS+=("$crc"); OFFSETS+=("$offset")
  { le 0x04034b50 4; le 20 2; le 0x800 2; le 0 2; le 0 2; le 33 2
    le "$crc" 4; le "$size" 4; le "$size" 4; le "${#file}" 2; le 0 2
    printf '%s' "$file"
    while IFS= read -r line || [[ -n $line ]]; do
      # readの終了状態を保持して、末尾改行がないファイルもそのまま格納する。
      printf '%s' "$line"
      (( size -= ${#line} )) || true
      if (( size > 0 )); then printf '\n'; size=$((size - 1)); fi
    done < "$file"
  } >&3
  offset=$((offset + 30 + ${#file} + SIZES[${#SIZES[@]}-1]))
done
central=$offset
for i in "${!FILES[@]}"; do
  file=${FILES[i]}
  { le 0x02014b50 4; le 20 2; le 20 2; le 0x800 2; le 0 2; le 0 2; le 33 2
    le "${CRCS[i]}" 4; le "${SIZES[i]}" 4; le "${SIZES[i]}" 4
    le "${#file}" 2; le 0 2; le 0 2; le 0 2; le 0 2; le 0 4; le "${OFFSETS[i]}" 4
    printf '%s' "$file"
  } >&3
  offset=$((offset + 46 + ${#file}))
done
{ le 0x06054b50 4; le 0 2; le 0 2; le "${#FILES[@]}" 2; le "${#FILES[@]}" 2
  le "$((offset - central))" 4; le "$central" 4; le 0 2
} >&3
exec 3>&-
printf 'Created build/backend.zip (%s files, stored ZIP)\n' "${#FILES[@]}"
