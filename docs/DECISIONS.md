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
