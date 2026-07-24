# 데모-게임 런북

## 기동과 상태 확인

```bash
docker compose up --build -d
curl -fsS http://localhost:8085/healthz
curl -fsS http://localhost:8085/api/rooms
curl -fsS http://localhost:8090/healthz
```

진행 중 룸에서 실제 survev 컨테이너를 재시작하고 재접속 세션의 팀·점수를 검증한다.

```bash
npm run test:resilience
```

정상 상태는 `room-0`부터 `room-2`까지 3개 룸이 보이고 각 룸의 `podName`이 `game-{ordinal}`과 일치하는 상태다.

### game-server 중계 주소

실제 데모는 `sandbox`의 management-server(단일 파드), `game-0`~`game-2`(고정 룸 파드), Redis PVC,
그리고 2개 replica gateway로 구성한다. gateway를 먼저 확인한다.

```bash
kubectl --context game-server -n sandbox get pods
kubectl --context game-server -n sandbox get service demo-game-gateway
```

외부 주소의 `/`는 운영 중계이고 `/play/room-N`은 참가자 전체 화면, `/watch/room-N`은 실제 survev
PixiJS 관전 화면이다. gateway replica가 하나 교체돼도 다른 replica가 같은 고정 룸 URL을 계속 제공한다.

## 룸과 봇 조절

운영 화면 또는 API에서 룸 수를 바꾼다. Kubernetes에서는 room-orchestrator만 `game` StatefulSet의 `spec.replicas`를 패치한다. 중간 ordinal을 제거하지 않는다.

```bash
curl -X POST http://localhost:8085/api/rooms \
  -H 'content-type: application/json' \
  -d '{"replicas": 5}'

npm run botctl -- spawn --count 30 --mode normal
npm run botctl -- spawn --count 1 --room room-0 --mode hack --nickname xX_Speed_Xx
```

룸 종료 버튼과 아래 API는 해당 룸의 상태만 논리적으로 리셋한다. StatefulSet의 중간 파드를 삭제하지 않는다.

```bash
curl -X POST http://localhost:8085/api/rooms/room-0/end
```

## 무중단 확인

파드 교체 전후에 Redis 스냅샷이 존재하는지와 재접속 결과를 확인한다. 진행 중인 판을 종료하지 않는다.

```bash
npm run test:e2e
# 실제 클러스터에서는 아래처럼 game-0만 삭제한 뒤 같은 브라우저(동일 localStorage 토큰)로 재접속한다.
# kubectl --context game-server -n sandbox delete pod game-0
# upstream Player의 character, team, kills(score)가 유지되는지 운영 스냅샷과 테스트 결과로 확인한다.
```

## 시나리오 주입과 복구

### 01 speed-hack

```bash
npm run botctl -- spawn --count 1 --room room-0 --mode hack --nickname xX_Speed_Xx
```

`input_rate_exceeded`, `movement_anomaly`, `tick_overrun` 로그와 `player_input_rate_total`/`tick_duration_ms`를 확인한다. Alertmanager firing은 Opsia `POST /api/rca/alertmanager`로 전달된다. 복구는 strict 게임 이미지 롤포워드이며, strict 모드는 위반 세션을 게임 내부에서 킥한다.

### 06 join-storm

이 시나리오는 게임 룸을 죽이지 않고 로비 용량만 부족하게 만드는 발표용 장애다.

- 정상 GitOps 상태는 `api-server` Deployment `replicas: 2`다.
- 각 로비 Pod의 `MAX_FIND_GAME_PER_SECOND`는 25이므로 정상 총 용량은 50 RPS다.
- 비용 절감이 포함된 잘못된 릴리스 PR에서 `replicas: 2`를 `replicas: 1`로 줄인다.
- 운영 콘솔의 `입장 서버 장애`는 로비 gateway에 40 RPS를 고정으로 보낸다. 프로세스 종료나 Pod 삭제를 arm하지 않는다.
- 1 Pod에서는 약 15/40건이 거절되어 실패율이 20% 장애 기준을 넘고, 2 Pod에서는 같은 40 RPS를 모두 처리한다.
- 부하는 운영자가 검증을 끝내기 전에 잊어도 15분 뒤 자동 종료된다.

장애 재현 전 토폴로지를 확인한다.

```bash
kubectl --context game-server -n sandbox get deploy api-server \
  -o jsonpath='{.spec.replicas}{" desired / "}{.status.readyReplicas}{" ready\n"}'
kubectl --context game-server -n sandbox get pods -l app=api-server
```

발표의 잘못된 릴리스는 저장소의 `deploy/k8s/base/api-server.yaml` 한 줄을 `replicas: 1`로 바꾼 PR이다.
배포가 끝난 뒤 운영 콘솔에서 admission-storm을 시작하고 아래를 확인한다.

```bash
kubectl --context game-server -n sandbox get pods -l app=api-server
kubectl --context game-server -n sandbox logs deploy/api-server --since=2m \
  | grep find_game_rejected
kubectl --context game-server -n sandbox port-forward svc/login-gateway-api 18081:8081
curl -fsS http://127.0.0.1:18081/metrics \
  | grep -E 'find_game_fail_ratio|opsia_sli_failure_ratio|find_game_capacity_per_second'
```

정상적인 관측 결과는 다음과 같다.

- 로비 전역 `opsia_sli_failure_ratio`가 0.2를 넘고 `DemoGameJoinStorm`이 firing한다.
- `find_game_rejected`의 reason은 `rate_limited`다.
- `api-server` `/healthz`는 계속 200이고 restart count는 증가하지 않는다.
- `game-room-0`~`game-room-4`의 Ready 상태와 기존 WebSocket 세션은 그대로다.
- 게임 운영 화면에서는 룸 카드가 모두 정상이고, 전역 `로비 입장` 배지만 빨간색이다.

복구 PR은 `api-server`를 다시 `replicas: 2`로 올린다. 부하를 먼저 끄지 말고 같은 40 RPS 아래에서
실패율이 20% 미만으로 내려가는 것을 확인한다. 운영 콘솔의 복구 완료 동작도 이 조건 전에는 409
`admission_capacity_recovery_not_verified`로 거절된다. 조건을 만족한 뒤 복구 완료를 누르면 부하를
중단한다.

### 08 bad-canary

새 game-server 이미지가 pull되지 않는 상태를 만들고 K8s `ImagePullBackOff` 이벤트를 확인한다. 복구는 검증된 stable 이미지로 롤백한다. 기존 룸은 Redis 스냅샷으로 계속 진행한다.

## 리셋

```bash
npm run demo:reset
docker compose down -v
```

`demo:reset`은 봇을 중지하고 각 룸을 논리적으로 초기화한다. 동작 중인 플레이어 판을 복구 절차 때문에 강제 종료하지 않는다.
