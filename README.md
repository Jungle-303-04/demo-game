# demo-game · Survev Control Room

실제 Survev 서버·클라이언트와 Opsia 운영 화면을 연결한 5개 게임방 데모다. 관리자 화면용 가짜 게임이나 점 애니메이션을 사용하지 않는다. 각 방은 실제 게임 프로세스, Redis 상태, 실제 프로토콜 봇으로 동작한다.

## 현재 구조

- `room-0` faction, `room-1` desert, `room-2` snow, `room-3` main, `room-4` woods를 각각 독립된 실제 게임 서버로 실행한다.
- 브라우저와 봇은 게임 Pod에 직접 붙지 않고 고정된 Session Gateway에 연결한다.
- Gateway는 입력에 단조 증가하는 sequence를 붙이고, ACK되지 않은 입력만 bounded buffer에 보관한다.
- 계획된 배포 때 Candidate가 full snapshot과 mutation journal을 복원하고 checksum을 맞춘 뒤 새 epoch의 authority를 얻는다.
- Gateway는 downstream WebSocket을 유지한 채 upstream만 바꾸고, 이전 epoch의 입력·출력·snapshot은 폐기한다.
- 검증이나 cutover가 실패하면 다음 방으로 진행하지 않고 더 높은 epoch로 안전하게 롤백한다.
- 격리된 `canary-room`은 public matchmaking과 live Redis namespace에서 분리되며, 실제 Pod 상태·메트릭·Kubernetes Event로 승격 여부를 결정한다.
- Release/Canary/Snapshot/Handoff 이벤트는 Redis Stream에 먼저 저장되고 Opsia로 재전송된다. Opsia는 같은 원장으로 Release DAG, 감사 Timeline, Active/Candidate 물리 보기를 투영한다.

보장 범위는 **계획된 게임 서버 교체**다. 브라우저 종료, 사용자 네트워크 단절, Session Gateway 전체 장애, 예고 없는 live Pod OOM까지 무중단이라고 주장하지 않는다.

## 요구 사항과 검사

Node.js 22, npm, pnpm이 필요하다. 코드 검사는 Docker나 WSL 없이 실행할 수 있다.

```bash
npm ci
pnpm --dir upstream-survev install --frozen-lockfile
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run test:survev
```

실제 Kubernetes handoff와 OOM 검증은 명시적으로 활성화한 환경에서만 실행한다.

```bash
K8S_HANDOFF_E2E=1 npm run test:e2e
CANARY_OOM_E2E=1 E2E_OOM_GAME_REVISION=<immutable-sha> npm run test:e2e
```

두 검사는 실제 클러스터와 이미지가 필요하며 기본 테스트에서는 skip된다. OOM 검사는 강제 종료나 합성 이벤트가 아니라 실제 container status와 Kubernetes Event를 확인한다.

## 로컬 실행

`.env.example`을 참고해 같은 네트워크의 휴대폰이 접속할 PC IPv4를 설정한다.

```bash
docker compose up --build -d
docker compose ps
```

- 관리자 화면: `http://localhost:8085/`
- Session Gateway: `http://localhost:8083/`
- 방 선택 API: `http://localhost:8081/api/find-game`
- 참가/관전: `http://<PUBLIC_GAME_HOST>:8083/play/room-0/`, `http://<PUBLIC_GAME_HOST>:8083/watch/room-0/`
- 직접 게임 포트 `8090`~`8094`는 loopback 진단용이며 live client와 bot은 Gateway를 사용한다.

전체 발표 기본값은 방당 10봇, 총 50봇이다. 메모리가 부족한 PC에서는 기능을 바꾸지 않고 봇만 줄일 수 있다.

```powershell
$env:OPSIA_MIN_BOTS_PER_ROOM = "2"
docker compose up --build -d
```

작업을 멈출 때 `docker compose stop`을 사용하면 컨테이너와 Redis 데이터는 보존하면서 메모리를 반환한다. Kind 클러스터까지 함께 켜 두면 `vmmemWSL` 사용량이 크게 늘 수 있으므로 로컬 코드 검사 중에는 Docker Desktop과 사용하지 않는 Kind 클러스터를 끈다.

## Session handoff API

Room Orchestrator의 제어 API는 `OPS_CONTROL_TOKEN`으로 보호한다.

- `POST /canary/validate` — immutable revision을 격리 Canary에 배치하고 실제 부하·메트릭 gate를 실행한다.
- `GET /canary/status`, `GET /canary/events` — 승인·차단 상태와 cursor 기반 이벤트를 조회한다.
- `POST /rollouts/handoff` — 승인된 같은 artifact를 `room-0`부터 `room-4`까지 한 방씩 교체한다.
- `GET /rollouts/handoff/status`, `GET /rollouts/handoff/events` — wave 진행과 방별 증거를 조회한다.

Compose에는 Kubernetes Candidate가 없으므로 Canary 승인을 요구하지 않는다. Kubernetes에서는 `REQUIRE_CANARY_APPROVAL=true`이며 승인되지 않은 artifact는 live wave에 들어갈 수 없다.

## Opsia 연결

`OPSIA_EVENT_ENDPOINT`를 Opsia의 `/agent/game-operation-events`로 지정하고, 해당 workspace/cluster에 등록된 cluster-agent token을 `OPSIA_AGENT_TOKEN`으로 전달한다. `OPSIA_WORKSPACE_ID`와 `OPSIA_CLUSTER_ID`는 그 토큰에 결박된 실제 식별자와 같아야 하며 불일치 이벤트는 Opsia가 거부한다. 토큰은 저장소에 커밋하지 않는다. 이벤트는 로컬 Redis 원장에 먼저 기록되므로 Opsia가 잠시 중단되어도 게임 handoff transaction을 되돌리지 않고 event ID 기반으로 재전송할 수 있다.

Kubernetes에서는 다음 Secret을 별도로 생성한다.

```bash
kubectl --context game-server -n sandbox create secret generic demo-game-opsia-agent \
  --from-literal=token='<registered cluster-agent token>'
```

`ops-policy` ConfigMap의 `opsiaEventEndpoint`에는 game-server 클러스터에서 접근 가능한 Opsia 주소를 넣는다.

## Kubernetes 배포

방은 StatefulSet ordinal이 아니라 `game-room-0`~`game-room-4` Deployment로 관리한다. 평상시 각 Deployment의 active replica는 하나이며, rollout 순간에만 `maxSurge: 1`, `maxUnavailable: 0` Candidate가 추가된다. `ops-policy`의 GameFleet 계약이 desired room 5개와 `maxConcurrentRooms: 1`을 고정한다.

실제 Secret과 TLS 인증서는 커밋하지 않는다.

```bash
kubectl --context game-server apply -f deploy/k8s/base/namespace.yaml
kubectl --context game-server -n sandbox create secret generic demo-game-admin --from-literal=token='<admin token>'
kubectl --context game-server -n sandbox create secret generic demo-game-control --from-literal=token='<service token>'
kubectl --context game-server -n sandbox create secret generic demo-game-session-gateway --from-literal=shared-secret='<gateway HMAC secret>'
kubectl --context game-server -n sandbox create secret tls demo-game-tls --cert=/absolute/path/to/tls.crt --key=/absolute/path/to/tls.key
kubectl --context game-server apply -k deploy/k8s/overlays/game-server
```

Canary와 live Deployment에는 같은 resource request/limit을 적용한다. 5개 live 방과 Canary를 한 Kind 노드에서 동시에 실행하려면 충분한 메모리가 필요하므로, 노트북에서는 네이티브 테스트를 우선하고 실제 클러스터 E2E 때만 한 환경을 켠다.

## 주요 환경 변수

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `REDIS_URL` | 비어 있음 | registry, lease, snapshot, journal, operation event 원장 |
| `MAX_ROOMS` / `INITIAL_ROOMS` | `5` | GameFleet의 실제 방 수 |
| `SESSION_GATEWAY_SHARED_SECRET` | 비어 있음 | Gateway→게임 연결 HMAC 인증 |
| `REQUIRE_SESSION_GATEWAY` | 배포에서 `true` | direct player/bot WebSocket 차단 |
| `OPSIA_MIN_BOTS_PER_ROOM` | `10` | 방별 실제 프로토콜 봇 수 |
| `OPSIA_EVENT_ENDPOINT` | 비어 있음 | Opsia game-operation ingest 주소 |
| `OPSIA_AGENT_TOKEN` | 비어 있음 | Opsia cluster-agent 인증 토큰 |
| `OPSIA_WORKSPACE_ID` / `OPSIA_CLUSTER_ID` | `demo-game` / `game-server` | 인증된 Opsia producer identity |
| `REQUIRE_CANARY_APPROVAL` | Kubernetes에서 `true` | live wave 전 같은 artifact의 Canary 승인 요구 |
| `OPS_ADMIN_TOKEN` | 비어 있음 | 관리자 브라우저 API 인증 |
| `OPS_CONTROL_TOKEN` | 비어 있음 | 내부 제어 API 인증 |

## 라이선스

이 저장소는 GPL-3.0으로 배포한다. `upstream-survev/`의 upstream 소스와 고지를 보존하고 변경도 같은 라이선스로 공개해야 한다.
