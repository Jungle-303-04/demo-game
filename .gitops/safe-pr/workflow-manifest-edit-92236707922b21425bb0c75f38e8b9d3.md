# Update StatefulSet redis

Human-approved Opsia manifest edit. Reason: BATTLEGROUNDS 상세 YAML 편집 및 배포 경로 검증

The cluster remains unchanged until this Safe PR is reviewed and merged.

- manifest_path: `deploy/k8s/base/redis.yaml`
- pr_kind: `safe_pr_manifest_edit`
- workflow_run_id: `workflow-manifest-edit-92236707922b21425bb0c75f38e8b9d3`
- environment: `production`

## Evidence

- commit_sha: `9b8b3fcbd1f6af59836cd2ba4dc862bdd5330c37`
- patch_sha256: `51a9b67915001cbee46e05d095bba6e4479d7c2e058074919ea53c5eea08bb12`

## Approval

- approval_ref: `approval-manifest-edit-92236707922b21425bb0c75f38e8b9d3`
- policy_decision_ref: `manifest-editor:approval-manifest-edit-92236707922b21425bb0c75f38e8b9d3:granted`

## Files

- `deploy/k8s/base/redis.yaml`: Approved YAML edit for StatefulSet/redis
