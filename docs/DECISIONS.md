# 구현 결정 로그

## 2026-07-16: 데모 코어 경계

`upstream-survev/`에는 원본 survev 소스를 보존하고, `services/game-server`에는 Opsia 데모에 필요한
단일 룸 어댑터를 둔다. 어댑터는 faction 50v50, 무한 판, Redis 상태 외부화, 세션 복귀와 관측 계약을
명시적으로 구현한다. 이는 upstream 변경을 최소화하면서 각 파드가 한 룸만 서빙한다는 불변식을 검증하기 위한 결정이다.

`upstream-survev/config.ts`에는 UI가 지원하는 세 번째 모드로 faction을 활성화하고 database를 비활성화했다.
faction map 정의의 `maxPlayers: 100`과 `factionMode: true`는 upstream 정의를 그대로 사용한다.

## 2026-07-16: 로컬 오케스트레이션

로컬 compose에서는 room-orchestrator가 Kubernetes API 대신 게임 서버의 관리 API를 호출하는 어댑터를 사용한다.
Kubernetes 배포에서는 StatefulSet replica 패치 권한만 가진 ServiceAccount와 매니페스트로 같은 의도를 표현한다.
게임 서버는 어느 환경에서도 kubectl을 실행하지 않는다.

## 2026-07-16: 복구 경계

엄격 모드는 `STRICT_MODE` 이미지/StatefulSet spec 값으로만 전환한다. 복구는 이미지 롤포워드/롤백 또는
api-server replicas 조정만 문서화하며, 로그의 세션 식별자를 외부 정책이나 ConfigMap에 주입하지 않는다.
