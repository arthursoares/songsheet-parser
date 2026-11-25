#!/usr/bin/env bash
# Verify the published image interface with a disposable chart and state volume.
set -euo pipefail

image=${1:?Usage: tests/smoke_qa_container.sh IMAGE}
work=$(mktemp -d)
container="songsheet-qa-smoke-$$-$RANDOM"
volume="$container-state"

cleanup() {
  local status=$?
  if ((status != 0)); then
    docker logs "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -r "$work"
}
trap cleanup EXIT

# On Linux the runner and container user can have different UIDs. Only the
# synthetic song directory is writable by both users.
mkdir -p "$work/songs/smoke" "$work/pdf"
chmod 0777 "$work/songs/smoke"
cat > "$work/songs/smoke/01-smoke.json" <<'JSON'
{"document":{"title":"QA smoke"},"songs":[{"title":"Before container save","sections":[{"label":"","bars":[[{"chord":"C","voicing":"x,3,2,0,1,0","text":"Hello"}]]}]}]}
JSON
sed 's/Before container save/After container save/' "$work/songs/smoke/01-smoke.json" > "$work/save.json"
docker volume create "$volume" >/dev/null

start() {
  docker run -d --name "$container" --publish 127.0.0.1::8001 \
    --mount "type=bind,src=$work/songs,dst=/library/songs" \
    --mount "type=bind,src=$work/pdf,dst=/library/pdf,readonly" \
    --mount "type=volume,src=$volume,dst=/state" \
    "$image" >/dev/null
  local address
  address=$(docker port "$container" 8001/tcp)
  origin="http://$address"
  for attempt in {1..30}; do
    if curl --silent --fail --max-time 3 "$origin/api/albums" > "$work/albums.json"; then
      grep -q '01-smoke.json' "$work/albums.json"
      return 0
    fi
    sleep 1
  done
  return 1
}

start
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/library/pdf"}}{{.RW}}{{end}}{{end}}' "$container")" = false
docker exec "$container" python -c 'import os; from pathlib import Path; assert os.getuid() != 0; assert not Path("/app/data").exists(); p = Path("/state/shapes/smoke"); p.parent.mkdir(parents=True, exist_ok=True); p.write_text("state retained")'
song_url="$origin/api/song/smoke/01-smoke.json"
curl --silent --show-error --fail --max-time 10 --dump-header "$work/headers" "$song_url" > /dev/null
revision=$(awk 'tolower($1) == "x-songsheet-revision:" {gsub(/\r/, "", $2); print $2}' "$work/headers")
[[ "$revision" =~ ^[[:xdigit:]]{64}$ ]]

curl --silent --show-error --fail --max-time 10 \
  -H "Origin: $origin" -H 'Content-Type: application/json' \
  --data-binary "@$work/save.json" "$song_url?revision=$revision" > "$work/saved.json"
grep -q '"ok": true' "$work/saved.json"
grep -q 'After container save' "$work/songs/smoke/01-smoke.json"
status=$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' \
  -H 'Origin: https://other-origin.invalid' --data-binary "@$work/save.json" "$song_url")
test "$status" = 403

curl --silent --show-error --fail --max-time 45 \
  "$origin/api/render/smoke/01-smoke.json?style=fork&diagrams=inline" > "$work/preview.html"
grep -q 'cmChordLine' "$work/preview.html"

docker rm -f "$container" >/dev/null
start
docker exec "$container" python -c 'from pathlib import Path; assert Path("/state/shapes/smoke").read_text() == "state retained"'
curl --silent --show-error --fail --max-time 10 "$origin/api/song/smoke/01-smoke.json" > "$work/reloaded.json"
grep -q 'After container save' "$work/reloaded.json"
printf '%s\n' 'QA smoke passed: non-root service, remapped port, song save, origin guard, Chord Chart, and durable state.'
