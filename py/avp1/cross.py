"""TS 구현과 왕복 시험을 하는 명령.

python -m avp1.cross check <file>           TS가 만든 {input, hex, decoded} 목록을 검사
python -m avp1.cross gen <seed> <n> <file>  무작위 프레임을 만들어 {input, hex, decoded} 목록으로 씀

check 는 케이스마다 두 가지를 봅니다. hex 를 디코드한 결과가 decoded 와 같은지(상대 인코더 -> 내 디코더),
input 을 인코드한 바이트가 hex 와 같은지(내 인코더 == 상대 인코더).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from .codec import (ACTION_KIND, ANSWER_STATUS, CAPTCHA_RESULT, CAPTCHA_TRIGGER, CHALLENGE_REASON, CHANGE_FAIL, CHANGE_KIND, CLIENT_KIND,
                    ERROR_CODES, FINISH_REASON, INPUT_PATH, INPUT_TYPE, KEY_CATEGORY, LOSS_REASON, MISSION_KIND,
                    MODIFIERS, NAV_TYPE, POINTER_TYPE, ROLE, RUN_LABEL, SOURCE, STATE_NAME, STATE_REASON, STOP_REASON,
                    WHEEL_MODE, decode_frame, encode_frame)

DICT = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-v0.2.json").read_text(encoding="utf-8"))["dict"]


def _hex(b: bytes) -> str:
    return b.hex(" ").upper()


def check(path: str) -> int:
    cases = json.loads(Path(path).read_text(encoding="utf-8"))
    bad = 0
    for i, c in enumerate(cases):
        buf = bytes.fromhex(c["hex"].replace(" ", ""))
        got = decode_frame(buf, DICT)
        if got != c["decoded"]:
            bad += 1
            print(f"case {i}: 디코드 결과가 다름\n  기대 {c['decoded']}\n  실제 {got}", file=sys.stderr)
            continue
        mine = _hex(encode_frame(c["input"], DICT))
        if mine != c["hex"]:
            bad += 1
            print(f"case {i}: 인코드 hex 가 다름\n  기대 {c['hex']}\n  실제 {mine}", file=sys.stderr)
    print(f"python check: {len(cases) - bad}/{len(cases)} 일치")
    return 1 if bad else 0


class _Gen:
    def __init__(self, rng: random.Random):
        self.r = rng

    def int(self, a: int, b: int) -> int:
        """a 이상 b 미만"""
        return self.r.randrange(a, b)

    def pick(self, xs):
        return xs[self.r.randrange(len(xs))]

    def enum(self, table: dict):
        # 값 표 밖의 숫자도 가끔 섞어 숫자 보존을 봄
        return self.int(0, 256) if self.r.random() < 0.05 else self.pick(list(table.values()))

    def text(self) -> str:
        return "".join(self.pick(list("abc_xyz019가나다é")) for _ in range(self.int(0, 12)))

    def f(self) -> float:
        return self.r.uniform(-1000, 1000)

    def target(self):
        return None if self.r.random() < 0.3 else self.int(1, 5000)

    def route(self):
        return self.pick([None, "/shop", "/shop/cart", self.int(0, 500) * 2 + 1])

    def event(self, t: int) -> dict:
        k = self.int(0, 15)
        if k == 0:
            return {"t_us": t, "event_type": "POINTER_MOVE", "dx": self.int(-300, 301), "dy": self.int(-300, 301)}
        if k == 1:
            return {"t_us": t, "event_type": self.pick(["POINTER_DOWN", "POINTER_UP"]), "x": self.int(-200, 3000),
                    "y": self.int(-200, 3000), "button": self.int(0, 5), "pointer_type": self.enum(POINTER_TYPE),
                    "trusted": self.r.random() < 0.5, "target": self.target()}
        if k == 2:
            return {"t_us": t, "event_type": self.pick(["KEY_DOWN", "KEY_UP"]), "key_category": self.enum(KEY_CATEGORY),
                    "trusted": self.r.random() < 0.5, "repeat": self.r.random() < 0.2,
                    "is_composing": self.r.random() < 0.2,
                    "modifier_flags": [m for m in MODIFIERS if self.r.random() < 0.3], "target": self.target()}
        if k == 3:
            return {"t_us": t, "event_type": "INPUT", "source": self.enum(SOURCE), "target": self.target(),
                    "input_type": self.enum(INPUT_TYPE), "text_length_delta": self.int(-50, 51),
                    "trusted": self.r.random() < 0.5}
        if k == 4:
            return {"t_us": t, "event_type": "WHEEL", "wheel_dx": self.int(-100000, 100001) / 100,
                    "wheel_dy": self.int(-100000, 100001) / 100, "wheel_delta_mode": self.enum(WHEEL_MODE),
                    "target": self.target()}
        if k == 5:
            return {"t_us": t, "event_type": "TARGET_INFO", "target": self.int(1, 5000), "target_role": self.enum(ROLE),
                    "av_key": self.pick([None, "search_box", "result_list", "cart_button", 9]),
                    "target_bbox": [self.int(-500, 3000), self.int(-500, 3000), self.int(0, 2000), self.int(0, 2000)]}
        if k == 6:
            return {"t_us": t, "event_type": self.pick(["NAVIGATION_START", "NAVIGATION_END"]),
                    "source": self.enum(SOURCE), "nav_type": self.enum(NAV_TYPE), "route": self.route()}
        if k == 7:
            return {"t_us": t, "event_type": "VIEWPORT_CHANGE", "viewport_width": self.int(0, 5000),
                    "viewport_height": self.int(0, 5000), "dpr_milli": self.int(500, 4000)}
        if k == 8:
            return {"t_us": t, "event_type": "COLLECTION_LOSS", "reason": self.enum(LOSS_REASON),
                    "count": self.int(0, 100000)}
        if k == 9:
            return {"t_us": t, "event_type": "UI_CHANGE_RENDERED", "anchor": self.int(0, 10),
                    "apply_lag_us": self.int(0, 100000), "visible_pct": self.int(0, 101)}
        if k == 10:
            return {"t_us": t, "event_type": "UI_CHANGE_FAILED", "anchor": self.int(0, 10),
                    "reason": self.enum(CHANGE_FAIL)}
        if k == 11:
            return {"t_us": t, "event_type": "CAPTCHA_VIEW", "phase": self.pick(["shown", "closed"]),
                    "challenge_no": self.int(1, 4), "view_x": self.int(-100, 2000), "view_y": self.int(-100, 2000),
                    "view_w": self.int(0, 2000), "view_h": self.int(0, 2000)}
        if k == 12:
            # 등록표에 없는 코드. payload 원본은 dt 로 시작해야 함
            return {"t_us": t, "event_type": "UNKNOWN", "type_code": self.pick([0x6E, 0x80, 0xF3]),
                    "extra": bytes(self.int(0, 8) for _ in range(self.int(0, 6))).hex().upper()}
        if k == 13:
            return {"t_us": t, "event_type": "PROTECTED_ACTION", "action_kind": self.enum(ACTION_KIND),
                    "target": self.target()}
        return self.checkpoint(t)

    def thousandths(self) -> float:
        # 홀수 천분의 일이라 정수 모양(2.0)이 나오지 않음. JS 와 Python 이 같은 JSON 바이트를 씀
        return (self.int(0, 10**6) * 2 + 1) / 1000

    def trajectory(self) -> dict:
        t = self.thousandths
        return {"v": 1, "n": self.int(0, 2000), "durationMs": self.int(0, 60000), "pathLengthPx": t(),
                "straightness": t(), "speedMean": t(), "speedCV": t(), "pauseCount": self.int(0, 50),
                "subMovements": self.int(0, 50), "jitterPx": t(), "maxJumpPx": t(), "dtCV": t(),
                "speedProfile": [t() for _ in range(self.int(0, 25))]}

    def checkpoint(self, t: int) -> dict:
        return {"t_us": t, "event_type": "CHECKPOINT", "pointer_known": self.r.random() < 0.8,
                "doc_visible": self.r.random() < 0.9, "window_focused": self.r.random() < 0.9,
                "pointer_type": self.pick(list(POINTER_TYPE.values())), "x": self.int(-100, 3000),
                "y": self.int(-100, 3000), "scroll_y": self.int(0, 50000), "anchor": self.int(0, 4)}

    def data(self, h: dict) -> dict:
        t = self.int(0, 900_000_000)
        h["timestamp_us"] = t
        events = []
        seq0 = self.int(1, 100000)
        for k in range(self.int(0, 30)):
            if k:
                # 프레임 안 정렬이 깨진 이벤트도 디코더는 받음
                t = max(0, t + self.int(-2000, 60000))
            e = self.checkpoint(t) if k == 0 else self.event(t)
            e["event_seq"] = seq0 + k
            events.append(e)
        prev = h["timestamp_us"]
        for e in events:
            if e["event_type"] == "UNKNOWN":
                dt = e["t_us"] - prev
                z = ((dt << 1) ^ (dt >> 31)) & 0xFFFFFFFF
                raw = bytearray()
                while z > 0x7F:
                    raw.append((z & 0x7F) | 0x80)
                    z >>= 7
                raw.append(z)
                e["raw"] = raw.hex().upper() + e.pop("extra")
            prev = e["t_us"]
        h["flags"] = ["HAS_CHECKPOINT"] if events else []
        return {"header": h, "events": events}

    def control(self, h: dict) -> dict:
        k = self.int(0, 13)
        # 키가 "9" 처럼 배열 번호 모양이면 JS 객체가 키 순서를 바꿔 hex 가 달라짐(명세 사본 json 규칙). 접두어로 피함
        js = lambda: {"k" + self.text(): self.pick([self.int(-99, 99), self.text(), [1, "b"], {"n": None}]) for _ in range(self.int(0, 3))}  # noqa: E731
        c: dict
        if k == 0:
            c = {"subtype": "HELLO", "proto_minor": self.int(2, 256), "caps": self.int(0, 16),
                 "client_kind": self.enum(CLIENT_KIND), "mission_kind": self.enum(MISSION_KIND),
                 "run_flags": self.int(0, 8), "sdk_version": self.text(), "client_key": self.text(),
                 "mission_id": self.text(), "t0_unix_us": self.int(0, 2**53), "viewport_width": self.int(0, 5000),
                 "viewport_height": self.int(0, 5000), "dpr_milli": self.int(0, 4000), "input_caps": self.int(0, 16),
                 "max_touch_points": self.int(0, 256), "browser_family": self.int(0, 16),
                 "browser_major": self.int(0, 200), "sampling_policy": self.int(0, 3), "env_flags": self.int(0, 16)}
            if self.r.random() < 0.5:
                c["timer_resolution_us"] = self.int(0, 1000)
        elif k == 1:
            c = {"subtype": "WELCOME", "session_id": bytes(self.int(0, 256) for _ in range(16)).hex(),
                 "server_open_unix_us": self.int(0, 2**53), "caps": 0, "server_flags": self.int(0, 16),
                 "flush_ms": 50, "keepalive_ms": 15000, "infer_interval_ms": self.int(100, 3000),
                 "window_ms": 10000, "min_action_events": 3, "captcha_threshold_milli": self.int(0, 1001),
                 "captcha_sustain_ms": 10000, "max_payload_bytes": 65536, "max_events_per_frame": 1024,
                 "max_unacked_frames": 64,
                 "dict": {k2: [""] + [self.text() for _ in range(self.int(0, 5))]
                          for k2 in self.r.sample(["targets", "routes", "states", "steps"], self.int(0, 5))}}
            if self.r.random() < 0.5:
                c["block_threshold_milli"] = self.int(0, 1001)
                c["captcha_trigger"] = self.enum(CAPTCHA_TRIGGER)
        elif k == 2:
            c = {"subtype": "CHANGE_ORDER", "anchor": self.int(1, 20), "kind": self.enum(CHANGE_KIND),
                 "target_av": self.pick([None, "search_box", "result_list", 7]), "deadline_ms": self.int(0, 10000),
                 "require_route": self.route(), "params": js()}
        elif k == 3:
            c = {"subtype": "FINISH", "reason": self.enum(FINISH_REASON), "last_data_seq": self.int(0, 10000),
                 "event_count": self.int(0, 100000), "collection_loss_count": self.int(0, 100)}
        elif k == 4:
            c = {"subtype": "STOP", "reason": self.enum(STOP_REASON)}
        elif k == 5:
            c = {"subtype": "ERROR", "code": self.pick(list(ERROR_CODES.values()) + [999]),
                 "fatal": self.r.random() < 0.5, "message": self.text()}
        elif k == 6:
            c = {"subtype": "FEATURE_SCHEMA", "schema_id": self.int(1, 10), "model_id": self.text(),
                 "model_version": self.text(), "window_steps": self.int(0, 300),
                 "features": [self.text() for _ in range(self.int(0, 6))],
                 "channels": [{"name": self.text(), "unit": self.text()} for _ in range(self.int(0, 5))]}
        elif k == 7:
            c = {"subtype": "CAPTCHA_ANSWER", "challenge_id": self.text(), "status": self.enum(ANSWER_STATUS),
                 "answer": js()}
            if self.r.random() < 0.5:
                c["answer"] = {**c["answer"], "elapsed_ms": self.int(0, 120000), "trajectory": self.trajectory()}
            if self.r.random() < 0.5:
                c["verification_token"] = self.text()
        elif k == 8:
            c = {"subtype": "SCORE_REQUEST"}
        elif k == 9:
            c = {"subtype": "CAPTCHA_CHALLENGE", "challenge_id": self.text(), "challenge_no": self.int(1, 4),
                 "window_id": self.int(0, 2**32), "reason": self.enum(CHALLENGE_REASON),
                 "ttl_ms": self.int(0, 120000), "asset_count": self.int(0, 9),
                 "asset_total_bytes": self.int(0, 524289), "meta": js()}
            if self.r.random() < 0.5:
                c["frame_url"] = self.text()
        elif k == 10:
            c = {"subtype": "CAPTCHA_RESULT", "challenge_id": self.text(), "result": self.enum(CAPTCHA_RESULT),
                 "next_state": self.enum(STATE_NAME)}
        elif k == 11:
            c = {"subtype": "RUN_LABEL", "label": self.enum(RUN_LABEL), "input_path": self.enum(INPUT_PATH),
                 "set_at_ms": self.int(0, 900000)}
        else:
            c = {"subtype": self.int(13, 256), "body_hex": bytes(self.int(0, 256) for _ in range(self.int(0, 6))).hex().upper()}
        return {"header": h, "control": c}

    def frame(self, seq: int) -> dict:
        h = {"version": 1, "msg_type": "", "flags": [], "event_count": 0, "seq": seq,
             "timestamp_us": self.int(0, 2**40), "payload_length": 0}
        kind = self.pick(["DATA", "DATA", "DATA", "ACK", "CONTROL", "CONTROL", "INFERENCE_RESULT",
                          "MODEL_INPUT", "STATE", "ASSET_CHUNK"])
        h["msg_type"] = kind
        if kind == "DATA":
            return self.data(h)
        if kind == "ACK":
            f = {"header": h}
            if self.r.random() < 0.7:
                f["ack"] = {"frame_crc32": f"{self.int(0, 2**32):08X}", "decoded_events": self.int(0, 1025)}
            return f
        if kind == "CONTROL":
            return self.control(h)
        if kind == "INFERENCE_RESULT":
            if self.r.random() < 0.3:
                h["flags"] = ["FINAL"]
            res = {"window_id": self.int(1, 2**32), "window_start_ms": self.int(0, 10**6),
                   "window_end_ms": self.int(0, 10**6), "event_count": self.int(0, 5000), "ai_score": self.r.random()}
            if self.r.random() < 0.7:
                res["first_event_seq"], res["last_event_seq"] = self.int(1, 10**5), self.int(1, 10**5)
                if self.r.random() < 0.6:
                    ext = {}
                    if self.r.random() < 0.7:
                        ext["schema_id"] = self.int(1, 9)
                    if self.r.random() < 0.7:
                        ext["inference_time_us"] = self.int(0, 10**6)
                    if self.r.random() < 0.7:
                        ext["shape"] = {"steps": self.int(0, 256), "features": self.int(0, 64)}
                    if self.r.random() < 0.7:
                        ext["features"] = [{"id": self.int(1, 65), "value": self.f()} for _ in range(self.int(0, 6))]
                    if self.r.random() < 0.7:
                        npt = self.int(0, 9)
                        ext["series"] = {"points": npt, "channels": [
                            {"id": self.int(1, 9), "scale": self.f(), "offset": self.f(),
                             "q": [self.int(-32768, 32768) for _ in range(npt)]} for _ in range(self.int(0, 4))]}
                    res["ext"] = ext
            return {"header": h, "result": res}
        if kind == "MODEL_INPUT":
            rows, cols = self.int(0, 4), self.int(0, 4)
            return {"header": h, "model_input": {"window_id": self.int(0, 2**32), "first_event_seq": self.int(0, 99),
                                                 "last_event_seq": self.int(0, 99), "dtype": "f32",
                                                 "downsampled": self.r.random() < 0.3, "rows": rows, "cols": cols,
                                                 "data": [[self.f() for _ in range(cols)] for _ in range(rows)]}}
        if kind == "STATE":
            return {"header": h, "state": {"state": self.enum(STATE_NAME), "reason": self.enum(STATE_REASON),
                                           "window_id": self.int(0, 2**32)}}
        data = bytes(self.int(0, 256) for _ in range(self.int(0, 40)))
        return {"header": h, "asset_chunk": {"challenge_id": self.text(), "asset_index": self.int(0, 8),
                                             "chunk_index": self.int(0, 16), "chunk_count": self.int(1, 17),
                                             "asset_size": self.int(0, 524289),
                                             "asset_sha256": bytes(self.int(0, 256) for _ in range(32)).hex(),
                                             "data_hex": data.hex().upper()}}


def gen(seed: int, n: int, path: str) -> int:
    g = _Gen(random.Random(seed))
    cases = []
    for i in range(n):
        f = g.frame(i + 1)
        buf = encode_frame(f, DICT)
        cases.append({"input": f, "hex": _hex(buf), "decoded": decode_frame(buf, DICT)})
    Path(path).write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
    print(f"python gen: {n}개")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["check"] and len(a) == 2:
        sys.exit(check(a[1]))
    if a[:1] == ["gen"] and len(a) == 4:
        sys.exit(gen(int(a[1]), int(a[2]), a[3]))
    print(__doc__, file=sys.stderr)
    sys.exit(2)
