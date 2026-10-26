#!/bin/bash
set -euo pipefail
cd /tmp/judgeyou-h2-independent-c1Ksrvpc
D=$PWD
BASE=/tmp/judgeyou-concurrency-r3-6mredFO3
IMAGE=$(cat "$BASE/image")
ORIGIN=judgeyou-h2-c1Ksrvpc-origin
GEN=judgeyou-h2-c1Ksrvpc-gen
cleanup() { docker rm -f "$GEN" "$ORIGIN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
[ -d "$D/source" ] || cp -a "$BASE/source" "$D/source"
cp "$BASE/judgeyou-r3-probe-server.mjs" "$D/"
cp "$BASE/image" "$D/"
expected=$(awk '$2=="k6-v1.3.0-linux-arm64.tar.gz"{print $1}' checksums.txt)
printf '%s  k6.tar.gz\n' "$expected" | sha256sum -c - > checksum-verification.txt
{ date -u +%FT%TZ; ./k6-v1.3.0-linux-arm64/k6 version; ./caddy version; uname -a; } > versions.txt
free -m > host-before.txt
docker ps --format '{{.Names}} {{.Status}}' > production-before.txt
docker run -d --name "$ORIGIN" --user 0:0 --network none --cpus 1 --memory 512m --memory-swap 512m --pids-limit 256 --tmpfs /tmp:rw,size=64m -e PUBLIC_DIR=/bench/source/dist -e HOME=/tmp -e XDG_DATA_HOME=/tmp/caddy-data -e XDG_CONFIG_HOME=/tmp/caddy-config -v "$D:/bench:ro" -w /bench/source --entrypoint sh "$IMAGE" /bench/origin.sh > origin.id
docker inspect "$ORIGIN" > origin.inspect.json
for case in probe burst paced; do
  count=1000; [ "$case" != probe ] || count=1
  docker exec "$ORIGIN" sh -c 'cat /sys/fs/cgroup/cpu.stat; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events' > "$case.origin.before.txt"
  set +e
  docker run -d --name "$GEN" --user 0:0 --network container:"$ORIGIN" --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 -e CASE="$case" -e COUNT="$count" -e K6_NO_USAGE_REPORT=true -e GOMEMLIMIT=850MiB -v "$D:/bench" -w /bench --entrypoint /bench/k6-v1.3.0-linux-arm64/k6 "$IMAGE" run --address 127.0.0.1:6565 --out "json=/bench/$case.raw.jsonl" /bench/load.js > "$case.generator.id"
  status=$?
  set -e
  [ "$status" = 0 ] || exit "$status"
  docker inspect "$GEN" > "$case.generator.inspect.json"
  (
    while [ "$(docker inspect "$GEN" --format '{{.State.Running}}')" = true ]; do
      for name in "$GEN" "$ORIGIN"; do
        pid=$(docker inspect "$name" --format '{{.State.Pid}}')
        group=$(awk -F: '$1=="0"{print $3}' "/proc/$pid/cgroup")
        python3 - "$name" "/sys/fs/cgroup$group" <<'PY'
import json,sys,time,pathlib
p=pathlib.Path(sys.argv[2])
def read(f):
 try:return (p/f).read_text().strip()
 except:return None
print(json.dumps({'time':time.time(),'container':sys.argv[1],'cpu':read('cpu.stat'),'memoryCurrent':read('memory.current'),'memoryPeak':read('memory.peak'),'memoryEvents':read('memory.events')}))
PY
      done
      sleep 0.5
    done
  ) > "$case.resources.jsonl" 2> "$case.resources.stderr" &
  monitor=$!
  docker wait "$GEN" > "$case.exit"
  wait "$monitor" || true
  docker logs "$GEN" > "$case.console.txt" 2>&1
  docker inspect "$GEN" --format '{{json .State}}' > "$case.generator.state.json"
  docker exec "$ORIGIN" sh -c 'cat /sys/fs/cgroup/cpu.stat; cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.events' > "$case.origin.after.txt"
  docker rm "$GEN" >/dev/null
  echo "$case exit=$(cat "$case.exit")"
  if [ "$(cat "$case.exit")" != 0 ]; then tail -15 "$case.console.txt"; fi
  if [ "$case" = probe ] && [ "$(cat "$case.exit")" != 0 ]; then exit 1; fi
 done
docker stop -t 8 "$ORIGIN" >/dev/null
docker logs "$ORIGIN" > origin.console.jsonl 2>&1
docker inspect "$ORIGIN" --format '{{json .State}}' > origin.state.json
free -m > host-after.txt
docker ps --format '{{.Names}} {{.Status}}' > production-after.txt
