# ACTVERI AVP/1 프로토콜 연습 저장소

AVP/1은 S(t) LAB 클라이언트와 통합 판별 서버가 WebSocket 바이너리 프레임으로 행동 이벤트, 판별 점수, 상태와 제어 메시지를 주고받는 규격입니다. 이 저장소에는 v0.3.1 명세 사본, TypeScript 코덱과 Protocol Client, Python 참조 코덱, 두 구현이 함께 읽는 시험 벡터가 있습니다.

## 폴더

```text
docs/avp1-protocol.md         v0.3.1 명세 사본. 정본은 actveri-protocol 저장소
docs/avp1-protocol-v0.3.md    v0.3 명세. v0.3.1 에서 바뀐 점을 대조할 때만 봄
docs/avp1-protocol-v0.2.md    v0.2 명세. v0.3 에서 바뀐 점을 대조할 때만 봄
docs/avp1-protocol-v0.1.md    v0.1 명세. 바이너리 골격의 근거로만 남김
docs/architecture.md          TS 패키지의 층과 import 규칙
test-vectors/avp1-v0.2.json   골든 벡터 TV1~TV22. 명세 본문과 같은 내용이고 두 구현의 계약
test-vectors/avp1-v0.3.json   v0.3 골든 벡터 TV23~TV35(차단, 보호 행동, WELCOME 새 필드, 궤적 요약, FINISH 뒤 DATA)
test-vectors/avp1-v0.3.1.json v0.3.1 골든 벡터 TV36~TV73(판단 결과 STATE 묶음, 캡챠 시드, json 수 한도, 끝 바이트, 세션 규칙)
test-vectors/avp1-v0.2-extra.json  명세 밖 경계 사례(오류 코드, 선택 필드, 확장 블록)
test-vectors/avp1-fuzz-findings.json  차등 퍼징에서 찾은 불일치와 판단
tools/fuzz/                   TS와 Python 디코더 차등 퍼저
ts/                           TypeScript 패키지(pnpm, vitest)
py/                           Python 참조 코덱(표준 라이브러리만, pytest)
```

FastAPI 서버는 `py/avp1/codec.py` 를 그대로 가져다 씁니다. 데모 페이지는 `ts/dist/actveri.js` 파일 하나를 가져다 `createActveri()` 를 부릅니다.

## v0.3.1 에서 바뀐 점

위협 모델을 "클라이언트와 페이지는 믿지 않는다"로 두고 고쳤습니다. 판단 결과 `STATE` 끝에 그 보호 행동의 `action_event_seq` 와, 통과일 때 1회용 `action_token` 을 선택 묶음으로 싣습니다. TS `Session.protectedAction()` 은 번호가 같은 `action_allowed` 만 허용으로 돌려줍니다. 두 코덱은 json 안 수가 유한하지 않거나 2^53-1 을 넘으면, 짝 없는 서로게이트가 있으면 `E_CONTROL_BODY`, 이벤트 시각이 2^53-1 을 넘으면 `E_RANGE`, 겹친 WELCOME 사전 종류는 `E_MISSION`(표 밖 종류는 버림), `STATE`, `ACK`, `MODEL_INPUT`, `INFERENCE_RESULT` 끝에 남는 바이트는 `E_LENGTH` 로 봅니다. `Session` 은 WELCOME 값을 한도로 자르고, FINISH 뒤 ENDED 를 끝없이 기다리지 않으며, 수집기는 포커스 요소까지 민감 판정에 넣습니다. 항목마다 명세 사본의 'v0.3에서 바뀐 점 (v0.3.1)' 표에 A 번호로 있습니다.

## v0.3 에서 바뀐 점

판단은 보호할 행동(구매, 송금, 제출)을 알리는 `PROTECTED_ACTION` 이벤트를 받은 순간 그때까지의 근거로 한 번 합니다. 캡챠 기준 이상이면 캡챠, 캡챠 실패면 `STATE` 7 `BLOCKED`, 캡챠 통과 뒤에는 차단 기준 이상일 때만 차단입니다. 차단 기준과 발동 방식은 WELCOME 끝 선택 묶음(`block_threshold_milli`, `captcha_trigger`)에 실립니다.

두 코덱은 오류별 닫기 코드 표 `CLOSE_CODES` 를 내보내고, CONTROL 끝에 남는 바이트가 있으면 `trailing_offset` 을 알려 주고, ERROR `message` 를 256바이트 안에서 글자 경계로 자릅니다. TS `Session` 은 캡챠 에셋 조각을 모아 크기와 SHA-256 을 확인한 뒤 `onCaptcha` 로 넘기고, `captchaView`, `answerCaptcha` 로 화면 이벤트와 답을 보내며, `BLOCKED` 를 받으면 `FINISH(blocked)` 로 끝냅니다.

## v0.2 에서 바뀐 점

서버가 판정 토큰 대신 `INFERENCE_RESULT`(`ai_score`), `STATE`, CAPTCHA 중계 메시지를 클라이언트로 보냅니다. Message Type이 7개로 늘었고, CONTROL 본문은 JSON 대신 고정 바이너리 레이아웃입니다. 사이트마다 다른 값(`params`, `meta`, `answer`)만 길이 붙은 JSON으로 남았습니다.

이벤트는 ML 입출력 스펙 목록을 따라 다시 번호를 매겼습니다. 키는 `KEY_DOWN`, `KEY_UP` 으로 나뉘고, 값만 바꾸는 자동화를 잡으려고 `INPUT` 이 MVP에 들어왔습니다. 좌표는 음수를 담는 `svar` 이고, 대상은 세션 번호와 `TARGET_INFO` 로 보냅니다.

모든 비어 있지 않은 DATA는 `CHECKPOINT` 로 시작하고 그 안의 `event_seq` 로 이벤트 단위 누락을 셉니다. 서버 ACK에는 받은 프레임의 CRC32와 디코드한 이벤트 수가 실립니다.

재연결은 새 세션이라 v0.1의 RESUME, beacon, 판정 토큰 검증은 쓰지 않습니다. `ts/src/token.ts` 와 `py/avp1/token.py` 는 운영 단계 부록용으로 남아 있습니다.

명세 사본에서 정본과 달라진 곳은 커밋 메시지에 항목마다 적었습니다.

## TS 시험과 빌드

Node 22와 pnpm이 필요합니다. 아래 명령은 저장소 최상위에서 시작합니다.

```bash
cd ts
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` 에는 골든 벡터와 경계 사례, Session 단위 시험, 수집기와 화면 변화 시험, ws 시험 서버를 쓰는 연결 시험, 층 규칙 시험, TS와 Python 왕복 시험이 함께 돕니다. 왕복 시험은 `python` 명령으로 Python을 부르므로, 다른 이름이면 `PYTHON` 환경 변수로 경로를 줍니다.

`pnpm build` 는 의존성 없는 ESM 번들 `ts/dist/actveri.js` 와 타입 `ts/dist/actveri.d.ts` 를 만듭니다.

## Python 시험

Python 3.11 이상과 pytest가 필요합니다.

```bash
cd py
python -m pytest -q
```

## 왕복 시험만 따로 돌리기

고정 시드로 메시지 7종(v0.3 의 보호 행동 이벤트, WELCOME 묶음, 궤적 요약 포함)을 섞은 무작위 프레임 400개씩을 만듭니다. TS가 만든 것은 Python이, Python이 만든 것은 TS가 디코드해 같은 JSON인지 보고, 같은 입력을 자기 인코더로 써서 hex까지 같은지 봅니다.

```bash
cd ts
pnpm exec vitest run test/cross-lang.test.ts
```

다른 시드로 더 돌려 볼 때는 `AVP_CROSS_SEED=7 pnpm exec vitest run test/cross-lang.test.ts` 처럼 시드를 줍니다.

Python 쪽 명령을 직접 부를 수도 있습니다. `gen` 은 무작위 프레임을 파일로 쓰고, `check` 는 그 형식의 파일을 디코드하고 다시 인코드해 비교합니다.

```bash
cd py
python -m avp1.cross gen 20261109 400 cases.json
python -m avp1.cross check cases.json
```

## 차등 퍼징

정상 프레임 대신 이상한 입력(골든 벡터를 뒤튼 것, 무작위 바이트, 헤더만 맞는 프레임, 한도 경계)을 TS와 Python 디코더에 함께 넣어 결과, 오류 코드, 다시 인코드한 바이트를 비교합니다. `pnpm test` 에는 1,000건짜리 짧은 판이 들고, 전체 판은 직접 돌립니다. TS 쪽은 `ts/node_modules` 의 esbuild 로 `src/codec.ts` 를 묶어 쓰므로 `pnpm install` 뒤에 돌립니다.

```bash
python tools/fuzz/fuzz.py --total 22000 --reduce 40 --report fuzz-report.json
```

찾은 불일치와 판단(고침, 규격 결정 필요, 규격이 허용)은 `test-vectors/avp1-fuzz-findings.json` 에 있고, 그 가운데 고친 항목은 두 코덱의 벡터 시험이 함께 읽습니다.
