# 데모-게임

survev를 반영해 Opsia 운영 플랫폼과 연결한 faction 50v50 라이브 데모 게임이다. 룸은 StatefulSet ordinal과 1:1로 고정하고 Redis 스냅샷과 세션 토큰 재접속으로 진행 중인 무한 판을 보존한다.

## 주요 기능

- 무한 faction전: 승리 판정과 가스 없이 사망 플레이어를 같은 팀으로 리스폰한다.
- Redis `room:{id}:snapshot`과 lease: 1초 스냅샷, 파드 교체 후 캐릭터·팀·점수 복귀를 제공한다.
- `botctl spawn --count M [--room R] [--mode normal|hack]`: 정상 봇과 입력 폭주 봇을 지원한다.
- 운영 화면: 룸 상태, QR URL, 전체 미니맵, 생존자 순환 관전, 룸·봇 조절, 논리적 룸 리셋과 Opsia 이벤트 타임라인을 제공한다.
- `/metrics`와 구조화 JSON 로그, Alertmanager 규칙, ServiceMonitor를 제공한다.

## 설치 방법

Node.js 22와 Docker Compose가 필요하다.

```bash
npm install
npm run typecheck
npm run lint
npm run test
```

## 사용법

로컬 전체 데모를 기동하고 compose E2E까지 실행한다.

```bash
npm run test:compose
# 운영 화면: http://localhost:8085
```

데모를 직접 기동할 때는 다음 명령을 사용한다.

```bash
docker compose up --build
npm run botctl -- spawn --count 30 --mode normal
npm run botctl -- spawn --count 1 --room room-0 --mode hack --nickname xX_Speed_Xx
npm run demo:reset
```

운영 화면은 `http://localhost:8085`이고 매치메이킹 API는 `http://localhost:8081/api/find-game`이다. 플레이어 URL은 `/play/room-{ordinal}`, 관전 URL은 `/watch/room-{ordinal}` 형식을 사용한다.

## 환경 설정

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `REDIS_URL` | 비어 있음 | 비어 있으면 단위 테스트용 메모리 저장소를 사용한다. 배포에서는 Redis URL이 필수다. |
| `ROOM_ID` | `room-0` | 게임 프로세스가 서빙할 단일 룸 ID다. |
| `POD_NAME` | `game-0` | 구조화 로그와 registry에 기록할 파드 이름이다. |
| `STRICT_MODE` | `false` | StatefulSet 이미지 또는 spec 변경으로만 켜는 게임 내부 enforcement 모드다. |
| `MAX_FIND_GAME_PER_SECOND` | `25` | api-server가 join-storm을 거절하기 시작하는 초당 요청 수다. |

## 기여 방법

이 저장소는 GPL-3.0으로 배포한다. `upstream-survev/`의 upstream 소스와 고지를 보존하고, 변경은 같은 라이선스로 공개해야 한다.

