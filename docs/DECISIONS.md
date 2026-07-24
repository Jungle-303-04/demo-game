# 구현 결정 로그

## 2026-07-16: 데모 코어 경계

`upstream-survev/`에는 원본 survev 소스와 `server/src/opsia/` 어댑터를 함께 둔다. 컨테이너는
`server/dist/gameServer.js`를 직접 실행하고 `client/dist`를 서빙한다. 이전의 `services/game-server`
자체 `DemoRoom`/자체 tick/점 캔버스 구현은 삭제했다. 이 결정은 실제 survev의
`GameProcess → Game.update() → PlayerBarn`을 게임 상태의 유일한 실행 기반으로 유지한다.

`upstream-survev/config.ts`에는 UI가 지원하는 세 번째 모드로 faction을 활성화하고 database를 비활성화했다.
faction map 정의의 `maxPlayers: 100`과 `factionMode: true`는 upstream 정의를 그대로 사용한다.

## 2026-07-16: 로컬 오케스트레이션

로컬 compose에서는 room-orchestrator가 Kubernetes API 대신 게임 서버의 관리 API를 호출하는 어댑터를 사용한다.
Kubernetes 배포에서는 StatefulSet replica 패치 권한만 가진 ServiceAccount와 매니페스트로 같은 의도를 표현한다.
게임 서버는 어느 환경에서도 kubectl을 실행하지 않는다.

## 2026-07-16: 복구 경계

엄격 모드는 `STRICT_MODE` 이미지/StatefulSet spec 값으로만 전환한다. 복구는 이미지 롤포워드/롤백 또는
api-server replicas 조정만 문서화하며, 로그의 세션 식별자를 외부 정책이나 ConfigMap에 주입하지 않는다.

## 2026-07-24: 로비 용량 회귀 시연

정상 로비는 `api-server` 2개(각 25 RPS)로 50 RPS를 처리한다. 발표의 비용 절감 릴리스만 replicas를
1개로 줄이며, admission-storm은 정확히 40 RPS를 gateway로 보낸다. 따라서 정상 상태에서는 거절이
없고 회귀 상태에서 약 37.5%가 rate limit으로 거절된다. 이 시나리오는 overload fuse를 arm하거나
프로세스를 종료하지 않는다. 기존 게임 WebSocket과 5개 game-room은 장애 대상이 아니다.

복구 판정은 부하가 `saturated`이고 실제 요청률이 36~44 RPS인 같은 40 RPS 아래에서 실패율이
20% 미만으로 내려간 뒤에만 가능하다. 운영자 종료가 정상 경로이며, 잊힌 부하는 30분 절대 안전 한계에서
`safety_timeout`으로 중단하되 이를 복구로 인증하지 않는다. 로비 SLI는 workload identity 라벨이
포함된 `opsia_sli_failure_ratio`와 outcome별 `opsia_sli_requests_total`로 노출한다.
원인 분류는 메트릭 라벨에 하드코딩하지 않고 Git diff와 로그 evidence로 판단하며, 룸 UI에 전역
실패율을 귀속시키지 않는다.

## 2026-07-16: 실제 Game 상태 복원

Redis 어댑터는 실제 `Game.playerBarn` 투영만 직렬화한다. 투사체는 의도적으로 제외하고, 재접속할 때
기존 `PlayerBarn.addPlayer`가 새 `Player`를 만든 뒤 위치·체력·인벤토리·팀·킬 점수를 적용한다. lease는
`room:{id}:lease`로 중복 소유를 거절한다. strict 검증은 실제 `ClientBarn.handleMsg`가 `InputMsg`를
역직렬화한 뒤 실행되며, 전환은 `STRICT_MODE` StatefulSet spec 또는 이미지 변경만 사용한다.

## 2026-07-16: 교체 중 lease와 제어 봇의 경계

논리적 룸 종료는 StatefulSet ordinal을 삭제하지 않고 해당 룸의 Redis 스냅샷만 비운 뒤 실제 survev
`Game`을 재구성한다. 파드 교체 직후에는 이전 lease 만료와 겹칠 수 있으므로 새 서빙 프로세스가 최대 15초 동안
lease 획득을 재시도한다. 이는 Redis의 단일 소유 제약을 유지하면서 진행 중 판을 강제 종료하지 않는다.

로컬 데모의 30개 헤드리스 프로토콜 봇은 하나의 Compose 내부 IP를 공유한다. 따라서 `OPSIA_ROOM`일 때만
upstream의 동일 IP 접속 상한을 100으로 넓혔고, 일반 survev 배포의 기본 상한 5는 그대로 둔다. 이 예외는
실제 `ClientBarn` 접속 경로에 한정되며 별도 게임 경로나 스텁을 만들지 않는다.

## 2026-07-17: game-server 실제 데모 토폴로지

`game-server`에서는 기존 `sandbox`/`color-turf` 데모 워크로드를 제거하고, `target` 네임스페이스의
OpenTelemetry 에이전트와 관측 스택은 보존했다. 새 `sandbox`에는 관리 서버 파드 하나(룸 레지스트리,
API, 봇 실행기, 운영 콘솔 sidecar), Redis StatefulSet 하나, 그리고 `game-0`~`game-2`의 고정 룸
StatefulSet을 둔다. 관리 서버는 게임 상태를 만들지 않고 실제 survev 룸만 제어·관측한다.

공개 진입점은 두 replica의 Nginx gateway다. `/play/room-N`과 `/watch/room-N`은 각각 고정 ordinal의
survev `GameServer`로 프록시하며 WebSocket 업그레이드를 그대로 전달한다. 관전 페이지는 같은 upstream
PixiJS 클라이언트를 자동 입장시킨다. 이 안정적인 공개 URL과 Redis 스냅샷·원자적 lease 갱신·교체 child
process 재생성이 룸 파드 삭제 중에도 브라우저 재접속을 보장한다. 영속 Redis PVC는 EBS CSI 애드온을
사용한다.
