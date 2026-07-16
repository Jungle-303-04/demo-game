#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ops_url="${OPS_CONSOLE_URL:-http://localhost:8085}"
bot_url="${BOT_RUNNER_URL:-http://localhost:8084}"
session_id="compose-reconnect-session-0001"

wait_for_snapshot() {
  local result=""
  for _ in $(seq 1 50); do
    result="$(curl -fsS "$ops_url/api/ops/snapshot/room-0" 2>/dev/null || true)"
    if SNAPSHOT="$result" SESSION_ID="$session_id" node --input-type=module -e '
      const snapshot = JSON.parse(process.env.SNAPSHOT || "{}");
      process.exit(snapshot.players?.some((player) => player.sessionId === process.env.SESSION_ID) ? 0 : 1);
    '; then
      printf '%s' "$result"
      return 0
    fi
    sleep 1
  done
  echo "reconnect_player_not_found" >&2
  return 1
}

curl -fsS -X POST "$bot_url/bots/kill" -H 'content-type: application/json' --data '{}'
curl -fsS -X POST "$ops_url/api/rooms/room-0/end" -H 'content-type: application/json' --data '{}'
sleep 3
curl -fsS -X POST "$bot_url/bots/spawn" -H 'content-type: application/json' \
  --data "{\"count\":1,\"room\":\"room-0\",\"mode\":\"normal\",\"sessionId\":\"$session_id\"}" >/dev/null
before="$(wait_for_snapshot)"

docker compose -f "$root/docker-compose.yml" restart game-0 >/dev/null
for _ in $(seq 1 50); do
  if curl -fsS http://localhost:8090/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

# The pre-replacement socket is gone. Reusing the client session token makes
# the real PlayerBarn.addPlayer hook consume the Redis projection.
curl -fsS -X POST "$bot_url/bots/spawn" -H 'content-type: application/json' \
  --data "{\"count\":1,\"room\":\"room-0\",\"mode\":\"normal\",\"sessionId\":\"$session_id\"}" >/dev/null
after="$(wait_for_snapshot)"

BEFORE="$before" AFTER="$after" SESSION_ID="$session_id" node --input-type=module -e '
  import assert from "node:assert/strict";
  const find = (text) => JSON.parse(text).players.find((player) => player.sessionId === process.env.SESSION_ID);
  const before = find(process.env.BEFORE);
  const after = find(process.env.AFTER);
  assert.ok(before, "player_before_restart");
  assert.ok(after, "player_after_reconnect");
  assert.equal(after.team, before.team, "team_preserved");
  assert.equal(after.score, before.score, "score_preserved");
  console.log(JSON.stringify({ status: "ok", team: after.team, score: after.score }));
'
