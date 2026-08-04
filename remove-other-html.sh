#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ARCHIVE="$PROJECT_ROOT/.removed-html-backup.tar.gz"

KEEP_FILES=(
  "./index.html"
  "./profile-plan.html"
  "./profile-plan1.html"
  "./lite/consultation.html"
  "./privacy-policy.html"
  "./lite/privacy-policy.html"
)

cd "$PROJECT_ROOT"

for file in "${KEEP_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    printf 'Required file not found: %s\n' "$file" >&2
    exit 1
  fi
done

if [[ -e "$BACKUP_ARCHIVE" ]]; then
  printf 'Backup already exists: %s\nRun restore-html.sh before creating a new backup.\n' "$BACKUP_ARCHIVE" >&2
  exit 1
fi

files_to_remove=()
while IFS= read -r -d '' file; do
  keep=false
  for allowed_file in "${KEEP_FILES[@]}"; do
    if [[ "$file" == "$allowed_file" ]]; then
      keep=true
      break
    fi
  done

  if [[ "$keep" == false ]]; then
    files_to_remove+=("$file")
  fi
done < <(
  find . \
    -type d \( -name .git -o -name node_modules \) -prune \
    -o -type f -name '*.html' -print0
)

if [[ ${#files_to_remove[@]} -eq 0 ]]; then
  printf 'No HTML files need to be removed.\n'
  exit 0
fi

manifest_file="$(mktemp)"
trap 'rm -f "$manifest_file"' EXIT
printf '%s\0' "${files_to_remove[@]}" > "$manifest_file"

tar -czf "$BACKUP_ARCHIVE" --null --files-from="$manifest_file"
tar -tzf "$BACKUP_ARCHIVE" > /dev/null

for file in "${files_to_remove[@]}"; do
  rm -- "$file"
done

printf 'Removed %d HTML files.\n' "${#files_to_remove[@]}"
printf 'Kept:\n'
printf '  %s\n' "${KEEP_FILES[@]}"
printf 'Backup: %s\n' "$BACKUP_ARCHIVE"

