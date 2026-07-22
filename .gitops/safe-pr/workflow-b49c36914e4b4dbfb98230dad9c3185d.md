# Apply sandbox manifest

deployment/canary-room: ghcr.io/jungle-303-04/demo-game/game-server:0000000000000000000000000000000000000820 → ghcr.io/jungle-303-04/demo-game/game-server:stable

## GitOps Basis

- approval_ref: `approval-538ae4516b0fdbd7eaf08a9296d82e80`
- policy_decision_ref: `policy-decision:approval-538ae4516b0fdbd7eaf08a9296d82e80:safe_pr`
- diff_status: `intended_change`
- diff_basis: `managed-field-3way`
- artifact_digest: `sha256:6350940cf689417d531786865f861a0a8c1c3807782c318506f41424f3820fb4`
- rollback_patch: `.gitops/rollback/workflow-b49c36914e4b4dbfb98230dad9c3185d/deployment-canary-room-canary.yaml`


- manifest_path: `deploy/k8s/base/canary.yaml`
- pr_kind: `safe_pr_patch`
- workflow_run_id: `workflow-b49c36914e4b4dbfb98230dad9c3185d`
- environment: `sandbox`

## Evidence

- commit_sha: ``
- patch_sha256: `cc07ddce74c989e90dcc5439bf32928494276f427f806be95a3d89ac1fde00d6`

## Approval

- approval_ref: `approval-538ae4516b0fdbd7eaf08a9296d82e80`
- policy_decision_ref: `policy-decision:approval-538ae4516b0fdbd7eaf08a9296d82e80:safe_pr`

## Files

- `deploy/k8s/base/canary.yaml`: rendered Kubernetes manifest
- `.gitops/rollback/workflow-b49c36914e4b4dbfb98230dad9c3185d/deployment-canary-room-canary.yaml`: rollback manifest generated from live/previous values
