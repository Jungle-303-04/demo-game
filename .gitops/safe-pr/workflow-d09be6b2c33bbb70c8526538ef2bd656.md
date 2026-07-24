# [복구] api-server - 로비 replicas 원복 PR

## 복구 개요

lobby_capacity_saturation 후보가 가장 높은 점수로 평가되었고, 누락 근거 1개, 충족 근거 3개를 기준으로 최종 원인으로 선택했습니다. 추가 근거 수집이 필요해 운영자 선택 후 진행합니다.

- **복구 조치:** 로비 replicas 원복 PR
- **대상:** `sandbox / Deployment / api-server`
- **영향 범위:** target_workload
- **조치 위험도:** 보통

## 변경 내용

최근 배포에서 축소된 로비 replicas 를 GitOps 매니페스트에서 이전 값으로 되돌리는 Safe PR 을 제안합니다. 임시 증설과 달리 선언 상태를 함께 복구합니다.

**선택 이유:** lobby_capacity_saturation 후보가 가장 높은 점수로 평가되었고, 누락 근거 1개, 충족 근거 3개를 기준으로 최종 원인으로 선택했습니다.

**기대 결과:** 적용 후 검증 항목을 기준으로 정상화를 확인합니다.

## 사전 확인

- [ ] 대상 워크로드와 연결된 GitOps 레포가 있음
- [ ] 축소 이전의 승인 replicas 값 확인

## 적용 후 검증

- [ ] PR 병합 후 선언 replicas 와 실행 replicas 일치
- [ ] 매치메이킹 실패율 하락 유지

## 실패 시 복원

생성된 PR 또는 merge commit 을 revert 합니다.

<details>
<summary>추적 정보</summary>

- 복구 계획: `recovery:object://evidence/c5d87285-ac50-4867-a946-4e96a25dc2da.json`
- 장애: `c5d87285-ac50-4867-a946-4e96a25dc2da`
- 조치: `object://evidence/c5d87285-ac50-4867-a946-4e96a25dc2da.json:replica_scale`

</details>

---

> Kyro 복구 파이프라인에서 생성된 PR입니다. 적용 전 변경 내용과 검증 계획을 확인해 주세요.

- manifest_path: `deploy/k8s/overlays/game-server`
- pr_kind: `safe_pr_patch`
- workflow_run_id: `workflow-d09be6b2c33bbb70c8526538ef2bd656`
- environment: `production`

## Evidence

- commit_sha: `15aadafe27670802a15e00ed0a11078f29e5e5d5`
- patch_sha256: `ab72a3ee6e8b30c5362e7aaad6196285c8db2a7ffd94d435178e87f9827c64b2`

## Approval

- approval_ref: `approval-607710abd13ce4d62750c1f9ab20f80e`
- policy_decision_ref: `recovery:approval-607710abd13ce4d62750c1f9ab20f80e:selected`

## Files

- `.gitops/safe-pr/patches/c40ba4d4ff3d9b54a0a5ff81.yaml`: 로비 replicas 원복 PR (exact-base patch + inverse rollback)


## Structured Patch Plan

```yaml
apiVersion: gitops.krafton.dev/v1alpha1
kind: GitOpsScalarPatch
spec:
  actionType: replica_scale
  sourceType: raw-yaml
  sourceManifestSha256: sha256:810b35f49e7f092a740de2350dcdf6ca30f184b320407e413a3e51f4d7171b1d
  expectedBaseSha: 15aadafe27670802a15e00ed0a11078f29e5e5d5
  manifestPath: deploy/k8s/overlays/game-server
  replacements:
  - fieldPath: spec.replicas
    currentValue: 1
    desiredValue: 2
  rollbackReplacements:
  - fieldPath: spec.replicas
    currentValue: 2
    desiredValue: 1
```