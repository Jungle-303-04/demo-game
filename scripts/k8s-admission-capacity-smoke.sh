#!/usr/bin/env bash
set -euo pipefail

context="${1:?usage: k8s-admission-capacity-smoke.sh CONTEXT GATEWAY_URL [NAMESPACE]}"
gateway_url="${2:?usage: k8s-admission-capacity-smoke.sh CONTEXT GATEWAY_URL [NAMESPACE]}"
namespace="${3:-sandbox}"
duration_seconds="${ADMISSION_SMOKE_DURATION_SECONDS:-25}"

if (( duration_seconds < 21 )); then
  echo "ADMISSION_SMOKE_DURATION_SECONDS must be at least 21" >&2
  exit 2
fi

scale_and_wait() {
  local replicas="$1"
  kubectl --context "$context" --namespace "$namespace" \
    scale deployment/api-server "--replicas=${replicas}"
  kubectl --context "$context" --namespace "$namespace" \
    rollout status deployment/api-server --timeout=180s
}

restore_baseline() {
  kubectl --context "$context" --namespace "$namespace" \
    scale deployment/api-server --replicas=2 >/dev/null 2>&1 || true
  kubectl --context "$context" --namespace "$namespace" \
    rollout status deployment/api-server --timeout=180s >/dev/null 2>&1 || true
}
trap restore_baseline EXIT INT TERM

scale_and_wait 2
node scripts/check-admission-capacity.mjs \
  --endpoint "$gateway_url" --expect healthy --duration "$duration_seconds"

scale_and_wait 1
node scripts/check-admission-capacity.mjs \
  --endpoint "$gateway_url" --expect degraded --duration "$duration_seconds"

scale_and_wait 2
node scripts/check-admission-capacity.mjs \
  --endpoint "$gateway_url" --expect healthy --duration "$duration_seconds"

trap - EXIT INT TERM
