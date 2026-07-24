# Opsia 연동 계약

## 감지 경로

인시던트 감지는 대상 클러스터 Prometheus가 메트릭을 수집하고 Alertmanager가 규칙을 평가한 뒤 firing 웹훅을 Opsia `POST /api/rca/alertmanager`로 보내는 경로만 사용한다. 로비의 범용 SLI scrape와 alert rule은 Kyro 클러스터 설치기가 소유한다. `deploy/k8s/base/monitoring.yaml`과 `alertmanager.yaml`은 base kustomization에 포함되지 않는 선택적 게임 전용 규칙이며 로비 장애 감지 계약의 배포 입력이 아니다.

Opsia 내부 메트릭 임계 엔진은 사용하지 않는다. Opsia 원인 룰은 아래 로그의 `log_pattern`, K8s 이벤트의 `event_pattern`, K8s 상태의 `fact`만 사용한다. 숫자 메트릭 값은 Alertmanager 트리거와 evidence에는 사용하지만 Opsia 원인 룰 매처에는 사용하지 않는다.

## Prometheus 메트릭

| 메트릭 | 라벨 | 의미 |
| --- | --- | --- |
| `tick_duration_ms` | `room` | 게임 tick 처리 시간 histogram이다. |
| `player_input_rate_total` | `room`, `outcome` | 실제 survev 입력 디코드 훅에서 수락·거절된 입력 수다. |
| `players_online`, `players_alive` | `room` | 접속·생존 플레이어 수다. |
| `find_game_fail_ratio` | 없음 | 기존 대시보드 호환용 최근 매치메이킹 실패 비율이다. |
| `opsia_sli_failure_ratio` | `namespace`, `resource_kind`, `resource_name`, `service`, `sli`, `symptom` | Kyro가 장애 SLI와 Kubernetes 복구 대상을 같은 시계열에서 식별하는 표준 실패율이다. |
| `opsia_sli_requests_total` | 위 identity 라벨 + `outcome` | 유효한 입장 요청마다 증가하는 표준 counter다. `outcome`은 `accepted`, `rate_limited`, `directory_unavailable`, `no_room`, `room_unavailable` 등 실제 종료 결과다. |

join-storm의 표준 시계열은
`namespace="sandbox"`, `resource_kind="Deployment"`, `resource_name="api-server"`,
`sli="admission"`, `symptom="admission_failure"`를 갖는다.
Alertmanager는 tick p95, 거절 입력률, `opsia_sli_failure_ratio`에 대해 firing을 만들 수 있다.
receiver의 bearer token은 `opsia-alertmanager-token` Secret에서만 읽는다.
`root_category`처럼 분석 결론을 메트릭 라벨로 하드코딩하지 않는다. RCA는 이 SLI, 구조화 로그,
Kubernetes 상태와 Git 배포 diff를 결합해 `capacity_regression` 여부를 판정한다.

## 구조화 로그

게임 서버는 stdout에 JSON을 쓴다. 공통 필드는 `level`, `event`, `roomId`, `sessionId`, `nickname`, `server`, `detail`이다. Loki는 이 stdout을 evidence로 수집한다.

| 이벤트 | Opsia 원인 판별 패턴 | 용도 |
| --- | --- | --- |
| `input_rate_exceeded`, `movement_anomaly` | `abuse_traffic`의 `log_pattern` | speed-hack/입력 폭주 증거 |
| `find_game_rejected` | `join_storm`의 `log_pattern` | join-storm 증거 |
| `image_pull_back_off` | K8s ImagePullBackOff fact/event | bad-canary 증거 |
| `snapshot_saved`, `snapshot_restored`, `player_reconnected` | 운영 evidence | 무중단 복귀 증명 |
| `session_kicked` | `abuse_traffic`의 `log_pattern` | strict 이미지 배포 후 enforcement 증거 |

`sessionId`와 `nickname`은 로그 evidence와 화면 표시에만 사용한다. 어떤 복구 파라미터에도 사용하지 않는다.

## 복구 계약

허용 액션은 아래 세 종류다.

| 액션 | 대상 | 결과 |
| --- | --- | --- |
| 이미지 롤포워드 | `game` StatefulSet | strict 이미지 배포로 게임 내부 enforcement를 활성화한다. |
| 이미지 롤백 | `game` StatefulSet | bad-canary를 stable 이미지로 되돌린다. |
| `deployment_scale` | `api-server` Deployment | 잘못된 릴리스의 replicas 1을 정상값 2로 복구한다. |

`services/room-orchestrator/src/recovery.ts`는 위 요청만 workload patch로 변환한다. ConfigMap 동적 패치, 로그에서 유도한 세션 값 주입, 게임의 직접 클러스터 명령 실행은 계약 위반이다.

복구 중 연속성을 검증할 workload는 이름 패턴으로 추정하지 않는다. 대상 Deployment가
`opsia.dev/recovery-continuity=protected` 라벨로 명시하며, Kyro는 복구 전 수집한 해당
workload의 UID, Pod UID, 시작 시각, 재시작 횟수를 복구 후 evidence와 비교한다.

join-storm 복구 성공은 `/healthz`만으로 판정하지 않는다. 부하 컨트롤러가 `saturated` 상태이고,
설정 목표가 정확히 40 RPS이며, `opsia_sli_requests_total`로 확인한 실제 요청률이 36~44 RPS인 상태에서
`opsia_sli_failure_ratio < 0.2`가 된 뒤에만 시나리오 부하를 중단하고 복구 완료로 기록한다.
`safety_timeout`, `failed`, `stopped` 상태는 실패율과 관계없이 복구 성공이 아니다.

## Ops 이벤트 웹훅

Opsia는 운영 화면의 `POST /api/ops/events`로 `CANARY_STARTED`, `ROLLBACK_COMPLETED`, `SCALE_COMPLETED` 같은 이벤트를 보낸다. 요청은 `{ "type": "CANARY_STARTED", ... }` 형식이며 운영 화면은 최근 50개를 타임라인에 표시한다.
