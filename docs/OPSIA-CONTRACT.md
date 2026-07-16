# Opsia 연동 계약

## 감지 경로

인시던트 감지는 대상 클러스터 Prometheus가 메트릭을 수집하고 Alertmanager가 규칙을 평가한 뒤 firing 웹훅을 Opsia `POST /api/rca/alertmanager`로 보내는 경로만 사용한다. `deploy/k8s/base/monitoring.yaml`과 `alertmanager.yaml`이 이 계약의 배포 입력이다.

Opsia 내부 메트릭 임계 엔진은 사용하지 않는다. Opsia 원인 룰은 아래 로그의 `log_pattern`, K8s 이벤트의 `event_pattern`, K8s 상태의 `fact`만 사용한다. 숫자 메트릭 값은 Alertmanager 트리거와 evidence에는 사용하지만 Opsia 원인 룰 매처에는 사용하지 않는다.

## Prometheus 메트릭

| 메트릭 | 라벨 | 의미 |
| --- | --- | --- |
| `tick_duration_ms` | `room` | 게임 tick 처리 시간 histogram이다. |
| `player_input_rate_total` | `room`, `outcome` | 실제 survev 입력 디코드 훅에서 수락·거절된 입력 수다. |
| `players_online`, `players_alive` | `room` | 접속·생존 플레이어 수다. |
| `find_game_fail_ratio` | 없음 | 최근 매치메이킹 실패 비율이다. |

Alertmanager는 tick p95, 거절 입력률, `find_game_fail_ratio`에 대해 firing을 만들 수 있다. receiver의 bearer token은 `opsia-alertmanager-token` Secret에서만 읽는다.

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
| `deployment_scale` | `api-server` Deployment | join-storm 동안 로비 replicas를 늘린다. |

`services/room-orchestrator/src/recovery.ts`는 위 요청만 workload patch로 변환한다. ConfigMap 동적 패치, 로그에서 유도한 세션 값 주입, 게임의 직접 클러스터 명령 실행은 계약 위반이다.

## Ops 이벤트 웹훅

Opsia는 운영 화면의 `POST /api/ops/events`로 `CANARY_STARTED`, `ROLLBACK_COMPLETED`, `SCALE_COMPLETED` 같은 이벤트를 보낸다. 요청은 `{ "type": "CANARY_STARTED", ... }` 형식이며 운영 화면은 최근 50개를 타임라인에 표시한다.
