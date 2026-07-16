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
# 실제 클러스터에서 game-0 파드를 삭제한 뒤 같은 브라우저(동일 localStorage 토큰)로 재접속한다.
# upstream Player의 character, team, kills(score)가 유지되는지 운영 스냅샷과 테스트 결과로 확인한다.
```

## 시나리오 주입과 복구

### 01 speed-hack

```bash
npm run botctl -- spawn --count 1 --room room-0 --mode hack --nickname xX_Speed_Xx
```

`input_rate_exceeded`, `movement_anomaly`, `tick_overrun` 로그와 `player_input_rate_total`/`tick_duration_ms`를 확인한다. Alertmanager firing은 Opsia `POST /api/rca/alertmanager`로 전달된다. 복구는 strict 게임 이미지 롤포워드이며, strict 모드는 위반 세션을 게임 내부에서 킥한다.

### 06 join-storm

매치메이킹 요청을 동시에 보내 `find_game_rejected` 로그와 `find_game_fail_ratio`를 확인한다. 복구는 api-server Deployment의 replicas 증설뿐이다.

### 08 bad-canary

새 game-server 이미지가 pull되지 않는 상태를 만들고 K8s `ImagePullBackOff` 이벤트를 확인한다. 복구는 검증된 stable 이미지로 롤백한다. 기존 룸은 Redis 스냅샷으로 계속 진행한다.

## 리셋

```bash
npm run demo:reset
docker compose down -v
```

`demo:reset`은 봇을 중지하고 각 룸을 논리적으로 초기화한다. 동작 중인 플레이어 판을 복구 절차 때문에 강제 종료하지 않는다.
