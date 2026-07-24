# Update Deployment api-server

Human-approved Opsia manifest edit. Reason: 신규 버전 배포와 로비 비용 최적화 시연: replicas 2에서 1로 축소

The cluster remains unchanged until this Safe PR is reviewed and merged.

- manifest_path: `deploy/k8s/base/api-server.yaml`
- pr_kind: `safe_pr_manifest_edit`
- workflow_run_id: `workflow-manifest-edit-71e448c8ed725244918305a36e29f871`
- environment: `production`

## Evidence

- commit_sha: `e30bdcbecfbc3ca66cdced26b1c15a159d8b7d90`
- patch_sha256: `40c96dcf0e4777df85dcf91cdbbb5ee4cccf3b4f1c39b012e1faac61675f3e24`

## Approval

- approval_ref: `approval-manifest-edit-71e448c8ed725244918305a36e29f871`
- policy_decision_ref: `manifest-editor:approval-manifest-edit-71e448c8ed725244918305a36e29f871:granted`

## Files

- `deploy/k8s/base/api-server.yaml`: Approved YAML edit for Deployment/api-server
