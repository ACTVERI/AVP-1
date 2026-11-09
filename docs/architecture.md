# 구조

TS 패키지는 층 6개로 나눕니다. 위층은 아래층을 가져다 쓸 수 있고, 아래층은 위층을 모릅니다. 규칙은 `ts/test/architecture.test.ts` 가 import 문을 읽어 검사하고, 어기면 시험이 실패합니다.

| 층 | 파일 | 하는 일 | 가져다 쓸 수 있는 층 |
|---|---|---|---|
| codec | `codec.ts`, `py/avp1/codec.py` | 바이트와 프레임, 이벤트 사이 변환. 입출력, DOM, 타이머 없음 | 없음 |
| token | `token.ts`, `py/avp1/token.py` | 판정 토큰 발급과 검증. 서버 쪽 암호 계산만 | codec |
| session | `session.ts` | Protocol Client 상태 기계. 50ms 묶음 전송, 프레임마다 CHECKPOINT, `event_seq`, 방향별 순서 번호, 누적 ACK와 CRC 대조, 미확인 프레임 한도, FINISH와 마지막 결과, 캡챠 중계(조각 조립, 크기와 SHA-256 확인, 답)와 차단, 탭 | codec |
| transport-ws | `transport-ws.ts` | 브라우저 네트워크 코드. WebSocket을 `Transport` 로 맞춤. v0.2 는 재연결이 새 세션이라 beacon 을 뺐음 | codec, session |
| collector, change | `collector.ts`, `change.ts` | DOM 이벤트 수집(대상 번호와 `TARGET_INFO`, 민감 칸 거르기 포함)과 화면 변화 적용. session 의 `push` 로 이벤트를 넘김 | codec, session. change 는 collector 의 `EventSink` 와 시각 변환도 씀 |
| sdk | `sdk.ts` | `createActveri()`. 수집기, session, WebSocket 을 잇고 HELLO 필드를 채움 | 위 층 전부(token 제외) |

## 지키는 규칙

순환 import 는 두지 않습니다. codec, token, session 은 DOM 없이 Node에서 돌아야 해서 `window`, `document`, `navigator`, `WebSocket` 같은 브라우저 전역을 쓰지 않습니다. session 은 네트워크와 시계를 `Transport`, `Clock` 인터페이스로 받으므로 가짜 타이머로 시험합니다.

외부 패키지와 Node 내장 모듈은 token 만 씁니다. 데모 사이트는 `pnpm build` 가 만든 `ts/dist/actveri.js` 파일 하나를 그대로 가져다 쓰므로, 번들에 `ws` 나 `node:` 모듈이 들어가면 브라우저에서 깨집니다. 같은 이유로 `index.ts` 는 token 을 내보내지 않습니다.

층마다 시험 파일이 따로 있습니다. 연결 전체는 `loopback.test.ts` 가 sdk 부터 ws 시험 서버까지 실제 소켓으로 돌려 봅니다.

## 새 파일을 더할 때

새 파일은 위 표의 어느 층인지 정한 뒤 이 문서와 `architecture.test.ts` 의 `ALLOWED` 표에 함께 적습니다. 표에 없는 파일은 시험이 실패합니다.
