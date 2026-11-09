# 변경 기록

AVP/1 규격과 두 코덱의 버전별 변경입니다. 항목마다 자세한 이유와 이전 판과의 대조표는 규격서(`docs/avp1-protocol.md`)의 'v0.3.1에서 바뀐 점 (v0.3.2)', 'v0.3에서 바뀐 점 (v0.3.1)', 'v0.2에서 바뀐 점 (v0.3)', 'v0.1에서 바뀐 점' 절에 있습니다.

## v0.3.2

캡챠를 CAPTCHA 서버가 내보내는 iframe 에서 풀게 바꿨습니다. 캡챠가 다른 출처의 iframe 이 되면 S(t) LAB 수집기가 그 안의 포인터를 보지 못해, 판별 서버가 DATA 로 궤적을 다시 계산하던 v0.3.1 규칙(A1)을 쓸 수 없기 때문입니다. 위협 모델은 그대로이고, 판정 근거는 CAPTCHA 서버의 재계산과 판별 서버의 토큰 consume 입니다. 더한 필드는 CONTROL 끝 선택 묶음이라 헤더 Version 은 1, HELLO `proto_minor` 는 3 입니다.

- `CAPTCHA_CHALLENGE` 끝에 `frame_url`(1,024B 이하, 불투명 값이라 클라이언트는 그대로 엶)을 붙였습니다. iframe 챌린지는 에셋 0, `meta` 는 `kind` 만이고 `ASSET_CHUNK` 를 보내지 않습니다. 에셋 중계는 바이트 배치를 지키려고 선택으로 남겼습니다.
- `CAPTCHA_ANSWER` 끝에 `verification_token`(128B 이하, `success` 일 때만)을 붙이고 `status` 에 `success`, `fail`, `frame_error` 를 더했습니다. `trajectory` 요약은 없앴습니다.
- 판별 서버는 토큰을 consume 해 `valid` 이고 같은 챌린지일 때만 통과로 봅니다. `frame_error` 는 `asset_error` 와 같이 1번만 다시 띄웁니다.
- 골든 벡터 TV74~TV87 을 더했습니다(`test-vectors/avp1-v0.3.2.json`). 기존 벡터는 그대로입니다.

항목마다 규격서 표의 B 번호가 붙어 있습니다.

## v0.3.1

위협 모델을 "클라이언트와 페이지는 믿지 않는다"로 두고 고쳤습니다. 기존 필드의 뜻과 크기는 그대로라 헤더 Version 은 1, HELLO `proto_minor` 는 3 입니다.

- 판단 결과 `STATE` 끝에 그 보호 행동의 `action_event_seq` 와, 통과일 때 1회용 `action_token` 을 선택 묶음으로 싣습니다. TS `Session.protectedAction()` 은 번호가 같은 `action_allowed` 만 허용으로 돌려줍니다.
- 두 코덱은 json 안 수가 유한하지 않거나 2^53-1 을 넘을 때, 짝 없는 서로게이트가 있을 때 `E_CONTROL_BODY`, 이벤트 시각이 2^53-1 을 넘을 때 `E_RANGE`, 겹친 WELCOME 사전 종류는 `E_MISSION`(표 밖 종류는 버림), `STATE`, `ACK`, `MODEL_INPUT`, `INFERENCE_RESULT` 끝에 남는 바이트는 `E_LENGTH` 로 봅니다.
- `Session` 은 WELCOME 값을 한도로 자르고, FINISH 뒤 ENDED 를 끝없이 기다리지 않습니다. 수집기는 포커스 요소까지 민감 판정에 넣습니다.
- 골든 벡터 TV36~TV73 을 더했습니다(`test-vectors/avp1-v0.3.1.json`).

항목마다 규격서 표의 A 번호가 붙어 있습니다.

## v0.3

판단은 보호할 행동(구매, 송금, 제출)을 알리는 `PROTECTED_ACTION` 이벤트를 받은 순간 그때까지의 근거로 한 번 합니다. 캡챠 기준 이상이면 캡챠, 캡챠 실패면 `STATE` 7 `BLOCKED`, 캡챠 통과 뒤에는 차단 기준 이상일 때만 차단입니다. 차단 기준과 발동 방식은 WELCOME 끝 선택 묶음(`block_threshold_milli`, `captcha_trigger`)에 실립니다.

- 두 코덱은 오류별 닫기 코드 표 `CLOSE_CODES` 를 내보내고, CONTROL 끝에 남는 바이트가 있으면 `trailing_offset` 을 알려 주고, ERROR `message` 를 256바이트 안에서 글자 경계로 자릅니다.
- TS `Session` 은 캡챠 에셋 조각을 모아 크기와 SHA-256 을 확인한 뒤 `onCaptcha` 로 넘기고, `captchaView`, `answerCaptcha` 로 화면 이벤트와 답을 보내며, `BLOCKED` 를 받으면 `FINISH(blocked)` 로 끝냅니다.
- 골든 벡터 TV23~TV35 를 더했습니다(`test-vectors/avp1-v0.3.json`).

## v0.2

서버가 판정 토큰 대신 `INFERENCE_RESULT`(`ai_score`), `STATE`, CAPTCHA 중계 메시지를 클라이언트로 보냅니다. Message Type 이 7개로 늘었고, CONTROL 본문은 JSON 대신 고정 바이너리 레이아웃입니다. 사이트마다 다른 값(`params`, `meta`, `answer`)만 길이 붙은 JSON 으로 남았습니다.

- 이벤트는 ML 입출력 스펙 목록을 따라 다시 번호를 매겼습니다. 키는 `KEY_DOWN`, `KEY_UP` 으로 나뉘고, 값만 바꾸는 자동화를 잡으려고 `INPUT` 이 MVP 에 들어왔습니다. 좌표는 음수를 담는 `svar` 이고, 대상은 세션 번호와 `TARGET_INFO` 로 보냅니다.
- 모든 비어 있지 않은 DATA 는 `CHECKPOINT` 로 시작하고 그 안의 `event_seq` 로 이벤트 단위 누락을 셉니다. 서버 ACK 에는 받은 프레임의 CRC32 와 디코드한 이벤트 수가 실립니다.
- 재연결은 새 세션이라 v0.1 의 RESUME, beacon, 판정 토큰 검증은 쓰지 않습니다. `ts/src/token.ts` 와 `py/avp1/token.py` 는 규격서의 운영 단계 부록용으로 남아 있습니다.
- 골든 벡터 TV1~TV22 와 경계 사례를 두었습니다(`test-vectors/avp1-v0.2.json`, `avp1-v0.2-extra.json`).

## v0.1

24바이트 헤더, WebSocket 바이너리 프레임, 판정 토큰을 정한 첫 초안입니다. 규격은 `docs/avp1-protocol-v0.1.md` 에 남아 있고, 지금은 바이너리 골격의 근거로만 씁니다.
