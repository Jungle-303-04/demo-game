# 데모-게임

Opsia 운영 플랫폼과 연결한 faction 50v50 라이브 데모 게임이다. 실행 서버는 `upstream-survev/server/src/gameServer.ts`의 uWebSockets 진입점과 그 자식 프로세스의 `server/src/game/game.ts::Game`이며, 참가자 화면은 `upstream-survev/client`의 Vite + PixiJS 빌드 산출물이다. 별도 게임 루프나 점 캔버스 게임은 포함하지 않는다.

## 주요 기능

- 무한 faction전: upstream `Game.update()` 안에서 승리 판정·가스 종료를 제거하고 실제 `Player`를 같은 팀으로 리스폰한다.
- Redis `room:{id}:snapshot`과 lease: 실제 `Game.playerBarn`의 위치·체력·인벤토리·팀·킬 점수와 gas phase를 1초마다 느슨하게 저장한다.
- `botctl spawn --count M [--room R] [--mode normal|hack]`: `shared/net`의 실제 `JoinMsg`/`InputMsg`를 보내는 헤드리스 survev 클라이언트다.
- 운영 화면: 실제 `playerBarn` 2Hz 스냅샷으로 룸 상태·QR URL·SVG 미니맵·생존자 순환·논리적 룸 리셋·Opsia 타임라인을 제공한다.
- `/metrics`와 구조화 JSON 로그, Alertmanager 규칙, ServiceMonitor를 제공한다.

## 설치 방법

Node.js 22와 Docker Compose가 필요하다.

```bash
npm install
npm run build:survev
npm run typecheck
npm run lint
npm run test
```

## 사용법

로컬 전체 데모를 기동하고 compose E2E까지 실행한다.

```bash
npm run test:compose
# 참가자 PixiJS 화면: http://localhost:8090/play/room-0
# 운영 화면: http://localhost:8085
```

실제 survev 프로세스를 재시작하는 무중단 상태 보존 검증만 다시 실행하려면 다음을 사용한다.

```bash
npm run test:resilience
```

데모를 직접 기동할 때는 다음 명령을 사용한다.

```bash
docker compose up --build
npm run botctl -- spawn --count 30 --mode normal
npm run botctl -- spawn --count 1 --room room-0 --mode hack --nickname xX_Speed_Xx
npm run demo:reset
```

운영 화면은 `http://localhost:8085`, 룸 선택 API는 `http://localhost:8081/api/find-game`이다. 로컬 참가자 URL은 `http://localhost:809{ordinal}/play/room-{ordinal}`이며 그 URL이 실제 PixiJS 클라이언트와 해당 survev WebSocket을 함께 제공한다.

## cluster-2 실제 데모

`target`의 에이전트/관측 워크로드는 보존한 상태에서 아래 overlay를 적용한다. gateway가 생성한 외부 주소의
루트는 운영 중계 화면이며, 룸 이름을 누르면 해당 룸의 실제 PixiJS 전체 화면으로 이동한다. `관전`은 같은
실제 클라이언트를 iframe 중계 화면에 열어 자동 입장시킨다.

```bash
kubectl --context cluster-2 apply -k deploy/k8s/overlays/cluster-2
kubectl --context cluster-2 -n sandbox get service demo-game-gateway
# http://<EXTERNAL-HOST>/       운영 중계
# http://<EXTERNAL-HOST>/play/room-0  참가자 화면
# http://<EXTERNAL-HOST>/watch/room-0 관전 화면
```

## 환경 설정

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `REDIS_URL` | 비어 있음 | 비어 있으면 단위 테스트용 메모리 저장소를 사용한다. 배포에서는 Redis URL이 필수다. |
| `ROOM_ID` | `room-0` | upstream game process가 서빙할 단일 StatefulSet ordinal 룸 ID다. |
| `POD_NAME` | `game-0` | 구조화 로그와 registry에 기록할 파드 이름이다. |
| `STRICT_MODE` | `false` | StatefulSet 이미지 또는 spec 변경으로만 켜는 게임 내부 enforcement 모드다. |
| `MAX_FIND_GAME_PER_SECOND` | `25` | api-server가 join-storm을 거절하기 시작하는 초당 요청 수다. |

## 기여 방법

이 저장소는 GPL-3.0으로 배포한다. `upstream-survev/`의 upstream 소스와 고지를 보존하고, 변경은 같은 라이선스로 공개해야 한다.
