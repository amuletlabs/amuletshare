#!/bin/sh
set -eu

database=/data/share.db
mkdir -p /data

for migration in /migrations/*.sql; do
  sqlite3 "$database" < "$migration"
done

result="$(sqlite3 "$database" "PRAGMA integrity_check;")"
test "$result" = "ok"
sqlite3 "$database" "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('files','multipart_uploads') ORDER BY name;"
