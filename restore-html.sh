#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ARCHIVE="$PROJECT_ROOT/.removed-html-backup.tar.gz"

cd "$PROJECT_ROOT"

if [[ ! -f "$BACKUP_ARCHIVE" ]]; then
  printf 'Backup not found: %s\n' "$BACKUP_ARCHIVE" >&2
  exit 1
fi

archive_files=()
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  case "$file" in
    /*|../*|*/../*)
      printf 'Unsafe path in backup: %s\n' "$file" >&2
      exit 1
      ;;
  esac
  archive_files+=("$file")
done < <(tar -tzf "$BACKUP_ARCHIVE")

if [[ ${#archive_files[@]} -eq 0 ]]; then
  printf 'Backup is empty: %s\n' "$BACKUP_ARCHIVE" >&2
  exit 1
fi

for file in "${archive_files[@]}"; do
  if [[ -e "$PROJECT_ROOT/$file" ]]; then
    printf 'Restore stopped because the file already exists: %s\n' "$file" >&2
    exit 1
  fi
done

tar -xzf "$BACKUP_ARCHIVE" -C "$PROJECT_ROOT"
rm -- "$BACKUP_ARCHIVE"

printf 'Restored %d HTML files.\n' "${#archive_files[@]}"

