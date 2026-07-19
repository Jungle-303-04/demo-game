# demo-game · Survev Control Room

Survev faction 50v50 게임과 React 관리자 화면을 실제 프로토콜로 연결한 통합 저장소다. 게임 루프는 `upstream-survev/server`의 uWebSockets 부모 프로세스와 실제 `Game` 자식 프로세스를 사용하고, 참가자 화면은 `upstream-survev/client`의 PixiJS 빌드다. 관리자 화면은 `services/ops-console/web`의 React 19 앱이며 별도 모의 게임이나 점 캔버스를 사용하지 않는다.

## 실제로 연결된 기능

- 방 목록과 상태: room-orchestrator registry와 각 게임 프로세스의 `/summary`, `/ops/snapshot`을 합쳐 표시한다.
- 현재 상황 캔버스: 실제 맵 크기, 현재/다음 가스 중심과 반경, 플레이어 위치·속도·체력·장비·점수를 2Hz로 표시한다.
- 실제 게임 열기: 각 StatefulSet ordinal이 제공하는 PixiJS 클라이언트와 WebSocket으로 이동한다.
- 입장 잠금: Redis의 `room:{id}:join-lock`을 matchmaker와 게임의 실제 입장 요청 시점에 확인한다.
- 봇 부하: `shared/net`의 `JoinMsg`와 `InputMsg`를 사용하는 실제 WebSocket 클라이언트를 점진 투입하며, 연결 확인 후에만 작업 완료 수를 올린다.
- 스냅샷: 실제 `Game.playerBarn`의 위치·체력·인벤토리·팀·킬 점수와 gas phase를 Redis에 저장한다. 안전 종료는 저장 ACK 후 scale-down하고, 명시적 초기화·삭제 전까지 보존한다.
- 복구·장애 주입: Kubernetes에서는 StatefulSet scale과 지정된 `game-0..2` Pod 삭제를 수행한다. 로컬 Compose에서는 Kubernetes가 없으므로 해당 버튼을 명확히 비활성화한다.
- 운영 지표: 실제 Game child process의 tick rate, 500ms window tick p95, CPU와 RSS를 보여준다. CPU/RSS는 Pod 전체가 아니라 게임 자식 프로세스 값이다.

## 요구 사항과 설치

Node.js 22, npm, pnpm, Docker Compose가 필요하다.

```bash
npm ci
pnpm --dir upstream-survev install --frozen-lockfile
npm run typecheck
npm run lint
npm run test
```

`npm run test`, `test:unit`, `test:e2e`, `test:compose`는 Windows와 Linux에서 같은 명령으로 동작한다.

## 로컬 실행

```bash
docker compose up --build -d
docker compose ps
```

- React 관리자 화면: `http://localhost:8085/`
- 중앙 방 선택 API: `http://localhost:8081/api/find-game`
- 실제 게임: `http://localhost:8090/play/room-0/`, `http://localhost:8091/play/room-1/`, `http://localhost:8092/play/room-2/`

실제 프로토콜 봇과 복구 흐름은 다음 명령으로 확인한다.

```bash
export OPS_CONTROL_TOKEN="${OPS_CONTROL_TOKEN:-demo-game-local-control-token}"
npm run botctl -- spawn --count 10 --room room-0 --mode normal
npm run botctl -- spawn --count 1 --room room-0 --mode hack
npm run test:compose
npm run test:resilience
```

PowerShell에서는 먼저 `$env:OPS_CONTROL_TOKEN = "demo-game-local-control-token"`을 실행한다. Compose 기본값은 로컬 개발 전용이며 외부 환경에서 재사용하면 안 된다.

Compose에서는 `REQUIRE_ADMIN_TOKEN`을 켜지 않아 localhost에서 바로 확인할 수 있다. 서비스 사이의 제어 경로는 로컬에서도 `OPS_CONTROL_TOKEN`으로 보호한다. 외부에 공개할 때는 반드시 아래 Kubernetes 인증·TLS 설정을 사용한다.

## Kubernetes 배포

관리 API에는 bearer token을 요구하고 gateway는 HTTPS만 서비스한다. 실제 토큰과 인증서는 저장소에 커밋하지 않는다. overlay를 적용하기 전에 namespace와 세 Secret을 먼저 만든다. 운영 대상 context와 overlay는 모두 `game-server`를 사용한다.

```bash
kubectl --context game-server apply -f deploy/k8s/base/namespace.yaml

kubectl --context game-server -n sandbox create secret generic demo-game-admin \
  --from-literal=token='<32자 이상의 무작위 관리자 토큰>'

kubectl --context game-server -n sandbox create secret generic demo-game-control \
  --from-literal=token='<32자 이상의 무작위 서비스 제어 토큰>'

kubectl --context game-server -n sandbox create secret tls demo-game-tls \
  --cert=/absolute/path/to/tls.crt \
  --key=/absolute/path/to/tls.key

kubectl --context game-server apply -k deploy/k8s/overlays/game-server
kubectl --context game-server -n sandbox rollout status deployment/management-server
kubectl --context game-server -n sandbox rollout status deployment/demo-game-gateway
kubectl --context game-server -n sandbox get service demo-game-gateway
```

외부 DNS 이름과 일치하는 인증서를 `demo-game-tls`로 넣어야 한다. HTTP 80 요청은 HTTPS 443으로 리다이렉트된다.

- `https://<EXTERNAL-HOST>/` — 관리자 화면
- `https://<EXTERNAL-HOST>/play/room-0/` — 실제 참가자 화면
- `https://<EXTERNAL-HOST>/watch/room-0/` — 같은 실제 클라이언트의 관전 진입점

관리 화면이 처음 401을 받으면 상단의 관리자 토큰 버튼에서 `demo-game-admin`의 값을 입력한다. 토큰은 브라우저 `sessionStorage`에만 보관된다.

`demo-game-control`은 API server, ops-console, room-orchestrator, bot-runner, game-server 사이에서만 사용한다. 브라우저에 전달하거나 `demo-game-admin`과 같은 값으로 설정하지 않는다.

관리 Pod는 `Recreate` 전략으로 한 번에 하나만 실행된다. Kubernetes API token/CA volume은 room-orchestrator 컨테이너에만 mount되며, 권한은 `game` StatefulSet의 get/patch와 `game-0..2` Pod의 get/delete로 제한된다.

## 이미지와 배포 인계

브랜치를 push하는 것만으로 game-server 이미지가 자동 교체되지는 않는다. CI는 타입·lint·테스트·Kustomize 렌더링을 검증한다. 배포 담당자는 변경 commit으로 다섯 이미지를 build/push한 뒤 `deploy/k8s/overlays/game-server/kustomization.yaml`의 immutable tag를 갱신해야 한다.

- `services/game-server/Dockerfile`
- `services/api-server/Dockerfile`
- `services/room-orchestrator/Dockerfile`
- `services/bot-runner/Dockerfile`
- `services/ops-console/Dockerfile`

base의 `stable` 태그도 항상 pull하도록 설정되어 있지만, game-server에는 commit 또는 release별 immutable tag 사용을 권장한다.

## 주요 환경 변수

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `REDIS_URL` | 비어 있음 | registry, snapshot, lease, join-lock 저장소. 배포에서는 필수다. |
| `ROOM_ID` | `room-0` | 게임 StatefulSet ordinal의 논리 방 ID다. |
| `POD_NAME` | `game-0` | 구조화 로그와 상태에 기록할 Pod 이름이다. |
| `STRICT_MODE` | `false` | 과도한 실제 InputMsg를 차단하고 연결을 종료한다. |
| `MAX_FIND_GAME_PER_SECOND` | `25` | 중앙 matchmaker의 동시 포함 초당 요청 제한이다. |
| `PUBLIC_ROOM_URLS` | 비어 있음 | `room-0=https://...` 형식의 공개 게임 URL 목록이다. |
| `PUBLIC_ROOM_URL_TEMPLATE` | `/play/{roomId}/` | 공개 게임 URL 템플릿이다. |
| `REQUIRE_ADMIN_TOKEN` | `false` | `true`이면 빈 관리자 토큰으로 시작하지 않는다. |
| `OPS_ADMIN_TOKEN` | 비어 있음 | 모든 ops `/api/*` 요청에 필요한 bearer token이다. |
| `REQUIRE_CONTROL_TOKEN` | `false` | `true`이면 빈 서비스 제어 토큰으로 시작하지 않는다. |
| `OPS_CONTROL_TOKEN` | 비어 있음 | orchestrator, bot-runner, game `/ops/*` 사이에서만 쓰는 bearer token이다. 관리자 로그인 토큰과 분리한다. |
| `MAX_ROOMS` | `3` | 관리 가능한 StatefulSet ordinal 상한이다. |

## 라이선스

이 저장소는 GPL-3.0으로 배포한다. `upstream-survev/`의 upstream 소스와 고지를 보존하고 변경도 같은 라이선스로 공개해야 한다.
