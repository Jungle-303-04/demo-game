# Update StatefulSet redis

Human-approved Opsia manifest edit. Reason: 발표 데모 Git YAML 편집 경로 검증

The cluster remains unchanged until this Safe PR is reviewed and merged.

- manifest_path: `deploy/k8s/base/redis.yaml`
- pr_kind: `safe_pr_manifest_edit`
- workflow_run_id: `workflow-manifest-edit-bd7913be71e114d5e4e6e7090dec1771`
- environment: `production`

## Evidence

- commit_sha: `f6ee1a672ce1e7549c8fc844dcbd7d37215c2677`
- patch_sha256: `4a5c5e1127af54e08791b550fc0e31846775f07cb47455614eb66af47863b427`

## Approval

- approval_ref: `approval-manifest-edit-bd7913be71e114d5e4e6e7090dec1771`
- policy_decision_ref: `manifest-editor:approval-manifest-edit-bd7913be71e114d5e4e6e7090dec1771:granted`

## Files

- `deploy/k8s/base/redis.yaml`: Approved YAML edit for StatefulSet/redis
