#!/usr/bin/env bash
set -euo pipefail
r3_dir=$1
case_id=$2
mode=$3
shift 3
image=$(cat "$r3_dir/image")
name="judgeyou-r3-${case_id}"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
set +e
docker run --name "$name" --network none --cpus 1 --memory 512m --memory-swap 512m \
 -e NODE_ENV=production -e PUBLIC_DIR=/bench/source/dist -e PROBE_MODE="$mode" \
 --mount type=bind,src="$r3_dir",dst=/bench,readonly --workdir /bench/source --entrypoint sh "$image" -c '
 set -u
 if [ "$PROBE_MODE" = split ]; then
   node --disable-warning=ExperimentalWarning /bench/judgeyou-r3-probe-server.mjs > /tmp/server.jsonl 2>&1 &
   probe_pid=$!
   ready=0
   for attempt in $(seq 1 30); do
     if node -e "require(\"node:http\").get(\"http://127.0.0.1:8500/\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
     sleep 0.1
   done
   if [ "$ready" != 1 ]; then cat /tmp/server.jsonl; exit 1; fi
   node --disable-warning=ExperimentalWarning scripts/benchmark.js --target-url http://127.0.0.1:8500 "$@"
   status=$?
   kill -TERM "$probe_pid"
   wait "$probe_pid"
 else
   node --disable-warning=ExperimentalWarning scripts/benchmark.js "$@"
   status=$?
 fi
 node --input-type=module -e '\''import fs from "node:fs";const read=p=>fs.readFileSync("/sys/fs/cgroup/"+p,"utf8").trim();console.log(JSON.stringify({type:"cgroup",cpu:read("cpu.stat"),memoryPeakBytes:Number(read("memory.peak")),memoryEvents:read("memory.events")}));'\''
 exit "$status"
 ' sh "$@" > "$r3_dir/$case_id.jsonl" 2> "$r3_dir/$case_id.stderr"
status=$?
set -e
docker inspect "$name" --format '{{json .State}}' > "$r3_dir/$case_id.state.json"
if [ "$mode" = split ]; then docker cp "$name":/tmp/server.jsonl "$r3_dir/$case_id.server.jsonl"; fi
printf '%s exit=%s\n' "$case_id" "$status"
exit "$status"
