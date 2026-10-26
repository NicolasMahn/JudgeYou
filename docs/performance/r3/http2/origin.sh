#!/bin/sh
set -eu
node --disable-warning=ExperimentalWarning /bench/judgeyou-r3-probe-server.mjs &
node_pid=$!
/bench/caddy run --config /bench/Caddyfile --adapter caddyfile &
caddy_pid=$!
trap 'kill -TERM "$node_pid" "$caddy_pid"; wait' TERM INT
wait
