"""AVP/1 v0.3.2 참조 인코더와 디코더. 디코드 결과 모양은 test-vectors/avp1-v0.2.json, avp1-v0.3.json 이 정본입니다.

TS 쪽 ts/src/codec.ts 와 같은 표, 같은 필드 순서를 씁니다. 한쪽을 고치면 다른 쪽도 고치고
왕복 시험(ts/test/cross-lang.test.ts)으로 확인합니다.
"""

from __future__ import annotations

import json
import math
import re
import struct
from typing import Any

HEADER = struct.Struct("<2sBBHHIQI")

MAX_PAYLOAD = 65536
MAX_EVENTS_PER_FRAME = 1024
MAX_EVENT_PAYLOAD = 1024
MAX_CONTROL_BODY = 8192
MAX_JSON = 2048
MAX_SAFE_INTEGER = 2**53 - 1
U32 = 0xFFFFFFFF

MSG_TYPES = ["", "DATA", "ACK", "CONTROL", "INFERENCE_RESULT", "MODEL_INPUT", "STATE", "ASSET_CHUNK"]
HEADER_FLAGS = ["RETRANSMIT", "FINAL", "HAS_CHECKPOINT", "ACK_REQUESTED", "TRUNCATED"]

# ---------- 값 표 ----------

SOURCE = {0: "dom", 1: "observer", 2: "site", 3: "harness", 4: "sdk", 5: "electron_main", 15: "other"}
POINTER_TYPE = {0: "mouse", 1: "touch", 2: "pen", 3: "unknown"}
WHEEL_MODE = {0: "pixel", 1: "line", 2: "page"}
NAV_TYPE = {1: "initial_load", 2: "reload", 3: "push", 4: "replace", 5: "back_forward", 15: "other"}
ROLE = {0: "unknown", 1: "button", 2: "link", 3: "text_input", 4: "sensitive_input", 5: "checkbox", 6: "radio",
        7: "select", 8: "textarea", 9: "image", 10: "list_item", 11: "label", 12: "container", 13: "form",
        14: "dialog", 15: "other"}
INPUT_TYPE = {1: "insertText", 2: "insertFromPaste", 3: "deleteContentBackward", 4: "deleteContentForward",
              5: "insertCompositionText", 6: "insertFromDrop", 7: "historyUndo", 8: "historyRedo",
              9: "insertLineBreak", 15: "other"}
KEY_CATEGORY = {1: "letter", 2: "digit", 3: "whitespace", 4: "edit", 5: "enter", 6: "navigation", 7: "modifier",
                8: "function", 9: "symbol", 10: "ime", 15: "other"}
LOSS_REASON = {1: "buffer_overflow", 2: "encode_failed", 3: "before_t0", 4: "clock_backwards", 5: "apply_exception"}
CHANGE_FAIL = {1: "target_missing", 2: "route_mismatch", 3: "deadline", 4: "hidden", 5: "apply_exception",
               6: "session_finishing"}
CAPTCHA_PHASE = {1: "shown", 2: "closed"}
MODIFIERS = ["shift", "ctrl", "alt", "meta"]

SUBTYPES = {1: "HELLO", 2: "WELCOME", 3: "CHANGE_ORDER", 4: "FINISH", 5: "STOP", 6: "ERROR", 7: "FEATURE_SCHEMA",
            8: "CAPTCHA_ANSWER", 9: "SCORE_REQUEST", 10: "CAPTCHA_CHALLENGE", 11: "CAPTCHA_RESULT", 12: "RUN_LABEL"}
CLIENT_KIND = {1: "electron_lab", 2: "browser_sdk"}
MISSION_KIND = {1: "external_site", 2: "custom_mission", 3: "captcha"}
DICT_KINDS = {1: "targets", 2: "routes", 3: "states", 4: "steps"}
CHANGE_KIND = {1: "reorder", 2: "price_update", 3: "inline_error", 4: "async_reload", 15: "custom"}
FINISH_REASON = {1: "submit", 2: "stop", 3: "pagehide", 4: "client_timeout", 5: "user_stop", 6: "blocked"}
STOP_REASON = {1: "max_duration", 2: "limit", 3: "server_shutdown"}
ERROR_CODES = {1: "E_HEADER", 2: "E_MAGIC", 3: "E_VERSION", 4: "E_MSG_TYPE", 5: "E_FLAGS", 6: "E_LENGTH",
               7: "E_TRUNCATED", 8: "E_VARINT_TOO_LONG", 9: "E_FRAME_TOO_LARGE", 10: "E_EVENT_TOO_LARGE",
               11: "E_CONTROL_TOO_LARGE", 12: "E_CONTROL_BODY", 13: "E_SUBTYPE", 14: "E_HELLO_REQUIRED",
               15: "E_STATE", 16: "E_CLIENT_KEY", 17: "E_MISSION", 18: "E_NO_CHECKPOINT", 19: "E_RANGE",
               20: "E_SESSION_LIMIT", 21: "E_RATE_LIMIT", 22: "E_INTERNAL"}
# 오류 이름별 WebSocket 닫기 코드(명세 오류 코드 표). E_SUBTYPE 은 비치명이라 닫지 않음
CLOSE_CODES: dict[str, int | None] = {
    "E_HEADER": 4400, "E_MAGIC": 4400, "E_VERSION": 4426, "E_MSG_TYPE": 4400, "E_FLAGS": 4400, "E_LENGTH": 4400,
    "E_TRUNCATED": 4400, "E_VARINT_TOO_LONG": 4400, "E_FRAME_TOO_LARGE": 4413, "E_EVENT_TOO_LARGE": 4413,
    "E_CONTROL_TOO_LARGE": 4413, "E_CONTROL_BODY": 4400, "E_SUBTYPE": None, "E_HELLO_REQUIRED": 4401,
    "E_STATE": 4422, "E_CLIENT_KEY": 4403, "E_MISSION": 4404, "E_NO_CHECKPOINT": 4400, "E_RANGE": 4400,
    "E_SESSION_LIMIT": 4429, "E_RATE_LIMIT": 4429, "E_INTERNAL": 1011,
}
CHALLENGE_REASON = {1: "final_above_threshold", 2: "sustained_above_threshold", 3: "action_above_threshold"}
# 0, 1 은 v0.3.1 에셋 중계용. iframe 챌린지는 4~6 과 2, 3 을 씀
ANSWER_STATUS = {0: "answered", 1: "asset_error", 2: "timeout", 3: "cancelled", 4: "success", 5: "fail", 6: "frame_error"}
CAPTCHA_RESULT = {0: "fail", 1: "pass", 2: "expired", 3: "error"}
STATE_NAME = {1: "WARMING_UP", 2: "SCORING", 3: "CAPTCHA_PENDING", 4: "CAPTCHA_PASSED", 5: "CAPTCHA_FAILED",
              6: "ENDED", 7: "BLOCKED"}
STATE_REASON = {0: "none", 1: "final_above_threshold", 2: "sustained_above_threshold", 3: "challenge_timeout",
                4: "captcha_server_error", 5: "finish", 6: "limit", 7: "insufficient_data", 8: "model_unavailable",
                9: "block_after_captcha_fail", 10: "block_above_threshold", 11: "action_allowed"}
ACTION_KIND = {1: "purchase", 2: "transfer", 3: "submit", 4: "other"}
CAPTCHA_TRIGGER = {0: "protected_action", 1: "sustained", 2: "both"}
RUN_LABEL = {0: "unset", 1: "human", 2: "ai_agent"}
INPUT_PATH = {0: "unknown", 1: "physical", 2: "cdp_input", 3: "dom_direct", 4: "mixed"}

# ---------- 레이아웃 ----------
# (필드 이름, 형식, 표나 한도). 디코더와 인코더가 같은 목록을 읽어 순서가 어긋나지 않게 함

CHECKPOINT = 0x50
EVENTS: dict[int, tuple[str, list]] = {
    0x01: ("POINTER_MOVE", [("dx", "svar"), ("dy", "svar")]),
    0x02: ("POINTER_DOWN", [("x", "svar"), ("y", "svar"), ("button", "u8"), ("pointer_type", "enum", POINTER_TYPE),
                            ("trusted", "trusted"), ("target", "target")]),
    0x03: ("POINTER_UP", None),
    0x10: ("KEY_DOWN", [("key_category", "enum", KEY_CATEGORY), ("_", "keyflags"),
                        ("modifier_flags", "bits", MODIFIERS), ("target", "target")]),
    0x11: ("KEY_UP", None),
    0x14: ("INPUT", [("source", "enum", SOURCE), ("target", "target"), ("input_type", "enum", INPUT_TYPE),
                     ("text_length_delta", "svar"), ("trusted", "trusted")]),
    0x20: ("WHEEL", [("wheel_dx", "wheel"), ("wheel_dy", "wheel"), ("wheel_delta_mode", "enum", WHEEL_MODE),
                     ("target", "target")]),
    0x30: ("TARGET_INFO", [("target", "target"), ("target_role", "enum", ROLE), ("av_key", "dictref", "targets"),
                           ("target_bbox", "bbox")]),
    0x39: ("PROTECTED_ACTION", [("action_kind", "enum", ACTION_KIND), ("target", "target")]),
    0x40: ("NAVIGATION_START", [("source", "enum", SOURCE), ("nav_type", "enum", NAV_TYPE), ("route", "route")]),
    0x41: ("NAVIGATION_END", None),
    CHECKPOINT: ("CHECKPOINT", [("event_seq", "uvar"), ("_", "cpflags"), ("x", "svar"), ("y", "svar"),
                                ("scroll_y", "uvar"), ("anchor", "uvar")]),
    0x51: ("VIEWPORT_CHANGE", [("viewport_width", "uvar"), ("viewport_height", "uvar"), ("dpr_milli", "uvar")]),
    0x52: ("COLLECTION_LOSS", [("reason", "enum", LOSS_REASON), ("count", "uvar")]),
    0x60: ("UI_CHANGE_RENDERED", [("anchor", "uvar"), ("apply_lag_us", "uvar"), ("visible_pct", "u8")]),
    0x61: ("UI_CHANGE_FAILED", [("anchor", "uvar"), ("reason", "enum", CHANGE_FAIL)]),
    0x62: ("CAPTCHA_VIEW", [("phase", "enum", CAPTCHA_PHASE), ("challenge_no", "uvar"), ("view_x", "svar"),
                            ("view_y", "svar"), ("view_w", "uvar"), ("view_h", "uvar")]),
}
# 같은 배치를 쓰는 짝
for _code, _same in ((0x03, 0x02), (0x11, 0x10), (0x41, 0x40)):
    EVENTS[_code] = (EVENTS[_code][0], EVENTS[_same][1])
EVENT_CODES = {name: code for code, (name, _) in EVENTS.items()}

CONTROLS: dict[int, list] = {
    1: [("proto_minor", "u8"), ("caps", "uvar"), ("client_kind", "enum", CLIENT_KIND),
        ("mission_kind", "enum", MISSION_KIND), ("run_flags", "u8"), ("sdk_version", "str", 128),
        ("client_key", "str", 128), ("mission_id", "str", 128), ("t0_unix_us", "u64"), ("viewport_width", "uvar"), ("viewport_height", "uvar"),
        ("dpr_milli", "uvar"), ("input_caps", "u8"), ("max_touch_points", "u8"), ("browser_family", "u8"),
        ("browser_major", "uvar"), ("sampling_policy", "u8"), ("env_flags", "u8"),
        ("timer_resolution_us", "opt_uvar")],
    2: [("session_id", "hex16"), ("server_open_unix_us", "u64"), ("caps", "uvar"), ("server_flags", "u8"),
        ("flush_ms", "uvar"), ("keepalive_ms", "uvar"), ("infer_interval_ms", "uvar"), ("window_ms", "uvar"),
        ("min_action_events", "uvar"), ("captcha_threshold_milli", "uvar"), ("captcha_sustain_ms", "uvar"),
        ("max_payload_bytes", "uvar"), ("max_events_per_frame", "uvar"), ("max_unacked_frames", "uvar"),
        ("dict", "dicts"),
        # v0.3 선택 묶음. 둘이 함께 오거나 함께 빠짐
        ("_v03", "opt", [("block_threshold_milli", "u16"), ("captcha_trigger", "enum", CAPTCHA_TRIGGER)])],
    3: [("anchor", "uvar"), ("kind", "enum", CHANGE_KIND), ("target_av", "dictref", "targets"),
        ("deadline_ms", "uvar"), ("require_route", "route"), ("params", "json")],
    4: [("reason", "enum", FINISH_REASON), ("last_data_seq", "uvar"), ("event_count", "uvar"),
        ("collection_loss_count", "uvar")],
    5: [("reason", "enum", STOP_REASON)],
    6: [("code", "enum16", ERROR_CODES), ("fatal", "bool"), ("message", "cutstr", 256)],
    7: [("schema_id", "uvar"), ("model_id", "str", 64), ("model_version", "str", 32), ("window_steps", "uvar"),
        ("features", "names"), ("channels", "channels")],
    8: [("challenge_id", "str"), ("status", "enum", ANSWER_STATUS), ("answer", "json"),
        # v0.3.2 선택 묶음. iframe 이 success 와 함께 준 1회용 토큰
        ("_v032", "opt", [("verification_token", "str", 128)])],
    9: [],
    10: [("challenge_id", "str"), ("challenge_no", "uvar"), ("window_id", "u32"),
         ("reason", "enum", CHALLENGE_REASON), ("ttl_ms", "uvar"), ("asset_count", "u8"),
         ("asset_total_bytes", "uvar"), ("meta", "json"),
         # v0.3.2 선택 묶음. 있으면 iframe 챌린지이고 에셋 필드는 0
         ("_v032", "opt", [("frame_url", "str", 1024)])],
    11: [("challenge_id", "str"), ("result", "enum", CAPTCHA_RESULT), ("next_state", "enum", STATE_NAME)],
    12: [("label", "enum", RUN_LABEL), ("input_path", "enum", INPUT_PATH), ("set_at_ms", "uvar")],
}
SUBTYPE_CODES = {v: k for k, v in SUBTYPES.items()}
STATE_LAYOUT = [("state", "enum", STATE_NAME), ("reason", "enum", STATE_REASON), ("window_id", "u32"),
                # v0.3.1 선택 묶음. 판단 결과가 가리키는 보호 행동과, 통과일 때 1회용 행동 토큰
                ("_a6", "opt", [("action_event_seq", "uvar")]),
                ("_a5", "opt", [("action_token", "hex16")])]
RESULT_LAYOUT = [("window_id", "u32"), ("window_start_ms", "uvar"), ("window_end_ms", "uvar"),
                 ("event_count", "uvar"), ("ai_score", "score")]


class AvpError(Exception):
    def __init__(self, code: str, detail: str | None = None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _enc(detail: str) -> AvpError:
    return AvpError("E_ENCODE", detail)


# ---------- 읽기 ----------

class _Reader:
    def __init__(self, b: bytes, i: int = 0, end: int | None = None):
        self.b, self.i, self.end = b, i, len(b) if end is None else end

    @property
    def remaining(self) -> int:
        return self.end - self.i

    def take(self, n: int) -> bytes:
        if n > self.remaining:
            raise AvpError("E_TRUNCATED")
        out = self.b[self.i:self.i + n]
        self.i += n
        return out

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.take(2))[0]

    def i16(self) -> int:
        return struct.unpack("<h", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        v = struct.unpack("<Q", self.take(8))[0]
        # u64 필드(유닉스 µs)는 TS 에서 JSON 수로 다루므로 2^53 안이어야 두 구현이 같은 값을 냄
        if v > MAX_SAFE_INTEGER:
            raise AvpError("E_RANGE", "u64 가 2^53-1 초과")
        return v

    def f32(self) -> float:
        v = struct.unpack("<f", self.take(4))[0]
        if not math.isfinite(v):
            raise AvpError("E_RANGE", "f32 가 유한수가 아님")
        return v

    def uvar(self) -> int:
        n = 0
        for k in range(5):
            x = self.u8()
            # 5번째 바이트는 u32 의 상위 4비트만 담을 수 있음
            if k == 4 and x > 0x0F:
                raise AvpError("E_VARINT_TOO_LONG")
            n |= (x & 0x7F) << (7 * k)
            if not x & 0x80:
                return n
        raise AvpError("E_VARINT_TOO_LONG")

    def svar(self) -> int:
        z = self.uvar()
        return (z >> 1) ^ -(z & 1)

    def str(self, limit: int | None = None, limit_code: str = "E_CONTROL_TOO_LARGE") -> str:
        raw = self.take(self.uvar())
        if limit is not None and len(raw) > limit:
            raise AvpError(limit_code, f"문자열 {len(raw)}B 가 {limit}B 를 넘음")
        if b"\x00" in raw:
            raise AvpError("E_CONTROL_BODY", "문자열에 NUL")
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            raise AvpError("E_CONTROL_BODY", "문자열이 UTF-8 이 아님") from None

    def sub(self, n: int) -> "_Reader":
        if n > self.remaining:
            raise AvpError("E_TRUNCATED")
        r = _Reader(self.b, self.i, self.i + n)
        self.i += n
        return r


def _reject_constant(name: str):
    raise ValueError(name)


_SURROGATE = re.compile("[\ud800-\udfff]")


def _json_values_ok(v) -> bool:
    """json 안 수는 유한하고 절댓값 2^53-1 이하, 글자열에 짝 없는 서로게이트가 없어야 두 언어가 같은 값을 냄.
    깊이가 1,000 근처인 입력에서 재귀 한도로 TS 와 갈리지 않게 스택으로 돈다"""
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            for k, y in x.items():
                if _SURROGATE.search(k):
                    return False
                stack.append(y)
        elif isinstance(x, list):
            stack.extend(x)
        elif isinstance(x, str):
            if _SURROGATE.search(x):
                return False
        elif isinstance(x, bool) or x is None:
            continue
        elif isinstance(x, float):
            if not math.isfinite(x) or abs(x) > MAX_SAFE_INTEGER:
                return False
        elif isinstance(x, int) and abs(x) > MAX_SAFE_INTEGER:
            return False
    return True


def _read_json(r: _Reader) -> dict:
    raw = r.take(r.uvar())
    if len(raw) > MAX_JSON:
        raise AvpError("E_CONTROL_TOO_LARGE", f"json {len(raw)}B")
    try:
        # NaN, Infinity 는 JSON 이 아니고 TS JSON.parse 도 받지 않음
        v = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise AvpError("E_CONTROL_BODY", "json 이 UTF-8 JSON 이 아님") from None
    if not isinstance(v, dict):
        raise AvpError("E_CONTROL_BODY", "json 최상위가 객체가 아님")
    if not _json_values_ok(v):
        raise AvpError("E_CONTROL_BODY", "json 수가 2^53-1 을 넘거나 유한하지 않음, 또는 짝 없는 서로게이트")
    return v


def _name(table: dict, n: int):
    return table.get(n, n)


def _dict_name(d: dict | None, key: str, idx: int):
    lst = (d or {}).get(key) or []
    return lst[idx] if 0 < idx < len(lst) else idx


def _wheel_out(raw: int):
    return raw // 100 if raw % 100 == 0 else raw / 100


def _read_fields(r: _Reader, layout: list, out: dict, d: dict | None) -> None:
    for spec in layout:
        name, kind = spec[0], spec[1]
        arg = spec[2] if len(spec) > 2 else None
        if kind == "u8":
            out[name] = r.u8()
        elif kind == "u16":
            out[name] = r.u16()
        elif kind == "opt":
            if r.remaining:
                _read_fields(r, arg, out, d)
        elif kind == "u32":
            out[name] = r.u32()
        elif kind == "u64":
            out[name] = r.u64()
        elif kind == "uvar":
            out[name] = r.uvar()
        elif kind == "opt_uvar":
            if r.remaining:
                out[name] = r.uvar()
        elif kind == "svar":
            out[name] = r.svar()
        elif kind == "enum":
            out[name] = _name(arg, r.u8())
        elif kind == "enum16":
            out[name] = _name(arg, r.u16())
        elif kind == "bool":
            v = r.u8()
            if v > 1:
                raise AvpError("E_RANGE", f"{name} 는 0 또는 1")
            out[name] = v == 1
        elif kind == "trusted":
            out[name] = bool(r.u8() & 1)
        elif kind == "keyflags":
            f = r.u8()
            out["trusted"], out["repeat"], out["is_composing"] = bool(f & 1), bool(f & 2), bool(f & 4)
        elif kind == "cpflags":
            f = r.u8()
            out["pointer_known"], out["doc_visible"], out["window_focused"] = bool(f & 1), bool(f & 2), bool(f & 4)
            out["pointer_type"] = POINTER_TYPE[(f >> 3) & 3]
        elif kind == "bits":
            f = r.u8()
            out[name] = [n for i, n in enumerate(arg) if f & (1 << i)]
        elif kind == "target":
            v = r.uvar()
            out[name] = v or None
        elif kind == "dictref":
            v = r.uvar()
            out[name] = _dict_name(d, arg, v) if v else None
        elif kind == "route":
            v = r.uvar()
            out[name] = None if v == 0 else _dict_name(d, "routes", v >> 1) if not v & 1 and v >> 1 else v
        elif kind == "bbox":
            out[name] = [r.svar(), r.svar(), r.uvar(), r.uvar()]
        elif kind == "wheel":
            out[name] = _wheel_out(r.svar())
        elif kind in ("str", "cutstr"):
            out[name] = r.str(arg)
        elif kind == "hex16":
            out[name] = r.take(16).hex()
        elif kind == "json":
            out[name] = _read_json(r)
        elif kind == "score":
            raw = r.take(4)
            v = struct.unpack("<f", raw)[0]
            if not math.isfinite(v) or not 0.0 <= v <= 1.0:
                raise AvpError("E_RANGE", "ai_score 가 0~1 유한수가 아님")
            out[name] = v
            out["ai_score_bits"] = f"{struct.unpack('<I', raw)[0]:08X}"
        elif kind == "dicts":
            dicts = {}
            seen_kinds: set[int] = set()
            for _ in range(r.u8()):
                kind_code, n = r.u8(), r.uvar()
                if n > 64:
                    raise AvpError("E_MISSION", f"사전 항목 {n}개")
                if kind_code in seen_kinds:
                    raise AvpError("E_MISSION", f"사전 종류 {kind_code} 가 두 번")
                seen_kinds.add(kind_code)
                items = [""] + [r.str(64, "E_MISSION") for _ in range(n)]
                # 표 밖 종류는 읽고 버림. 숫자 이름 키를 넣으면 JS 객체가 앞으로 옮겨 순서가 갈림
                if kind_code in DICT_KINDS:
                    dicts[DICT_KINDS[kind_code]] = items
            out[name] = dicts
        elif kind == "names":
            n = r.uvar()
            if n > 64:
                raise AvpError("E_CONTROL_TOO_LARGE", f"특징 {n}개")
            out[name] = [r.str(64) for _ in range(n)]
        elif kind == "channels":
            n = r.uvar()
            if n > 8:
                raise AvpError("E_CONTROL_TOO_LARGE", f"채널 {n}개")
            out[name] = [{"name": r.str(64), "unit": r.str(64)} for _ in range(n)]
        else:
            raise AssertionError(kind)


def _read_ext(r: _Reader) -> dict:
    ext: dict[str, Any] = {}
    seen: set[int] = set()
    for _ in range(r.u8()):
        tag, br = r.u8(), None
        br = r.sub(r.uvar())
        # 같은 tag 가 다시 오면 처음 것만, 모르는 tag 는 length 만큼 건너뜀
        if tag in seen or tag not in (1, 2, 3, 4, 5):
            continue
        seen.add(tag)
        if tag == 1:
            ext["schema_id"] = br.uvar()
        elif tag == 2:
            ext["inference_time_us"] = br.uvar()
        elif tag == 3:
            ext["shape"] = {"steps": br.uvar(), "features": br.uvar()}
        elif tag == 4:
            n = br.uvar()
            if n > 64:
                continue  # 한도를 넘은 블록만 버림
            ext["features"] = [{"id": br.uvar(), "value": br.f32()} for _ in range(n)]
        elif tag == 5:
            nch, npt = br.u8(), br.u16()
            if nch > 8 or npt > 128:
                continue
            chans = []
            for _ in range(nch):
                cid, scale, offset = br.uvar(), br.f32(), br.f32()
                q = [br.i16() for _ in range(npt)]
                chans.append({"id": cid, "scale": scale, "offset": offset, "q": q,
                              "values": [offset + scale * x for x in q]})
            ext["series"] = {"points": npt, "channels": chans}
    return ext


def _decode_events(r: _Reader, count: int, ts: int, d: dict | None) -> list[dict]:
    events = []
    t = ts
    first_seq = 0
    pos: list[int] | None = None
    for k in range(count):
        etype = r.u8()
        if k == 0 and etype != CHECKPOINT:
            raise AvpError("E_NO_CHECKPOINT")
        length = r.uvar()
        if length == 0:
            raise AvpError("E_TRUNCATED", "이벤트 length 0")
        if length > MAX_EVENT_PAYLOAD:
            raise AvpError("E_EVENT_TOO_LARGE")
        er = r.sub(length)
        t += er.svar()
        if t > MAX_SAFE_INTEGER:
            raise AvpError("E_RANGE", "이벤트 시각이 2^53-1 초과")
        e: dict[str, Any] = {"t_us": t, "event_seq": first_seq + k}
        if etype not in EVENTS:
            # dt 는 위에서 더했고 나머지는 건너뜀
            e.update(event_type="UNKNOWN", type_code=etype, length=length)
            events.append(e)
            continue
        name, layout = EVENTS[etype]
        e["event_type"] = name
        _read_fields(er, layout, e, d)
        if k == 0:
            first_seq = e["event_seq"]
        if name == "CHECKPOINT":
            pos = [e["x"], e["y"]] if e["pointer_known"] else None
        elif name in ("POINTER_DOWN", "POINTER_UP"):
            pos = [e["x"], e["y"]]
        elif name == "POINTER_MOVE" and pos is not None:
            pos = [pos[0] + e["dx"], pos[1] + e["dy"]]
            e["x"], e["y"] = pos
        elif name == "UI_CHANGE_RENDERED":
            e["applied_at_us"] = t - e["apply_lag_us"]
        events.append(e)
    return events


def _no_trailing(r: _Reader, what: str) -> None:
    # 고정 레이아웃 메시지는 선택 묶음, 확장 블록까지 읽은 뒤 남는 바이트를 받지 않음(검사 순서 11단계)
    if r.remaining:
        raise AvpError("E_LENGTH", f"{what} 끝에 {r.remaining}B 가 남음")


def decode_frame(buf: bytes | str, d: dict | None = None) -> dict:
    """명세 '검사 순서' 1~11단계. 상태와 방향(12단계 이후)은 세션이 봄"""
    if isinstance(buf, str):
        raise AvpError("E_MAGIC", "텍스트 메시지")
    buf = bytes(buf)
    if len(buf) < 24:
        raise AvpError("E_HEADER", "헤더 24바이트보다 짧음")
    magic, version, mtype, flags, count, seq, ts, plen = HEADER.unpack_from(buf)
    if magic != b"AV":
        raise AvpError("E_MAGIC")
    if version != 1:
        raise AvpError("E_VERSION")
    if not 1 <= mtype <= 7:
        raise AvpError("E_MSG_TYPE", f"Message Type {mtype}")
    if flags & 0xFFE0:
        raise AvpError("E_FLAGS")
    if plen > MAX_PAYLOAD:
        raise AvpError("E_FRAME_TOO_LARGE")
    if 24 + plen != len(buf):
        raise AvpError("E_LENGTH")
    tname = MSG_TYPES[mtype]
    if tname == "DATA" and count > MAX_EVENTS_PER_FRAME:
        raise AvpError("E_FRAME_TOO_LARGE")
    if tname != "DATA" and count != 0:
        raise AvpError("E_HEADER", f"{tname} 의 Event Count 가 0이 아님")
    if ts > MAX_SAFE_INTEGER:
        raise AvpError("E_HEADER", "Timestamp 가 2^53-1 초과")

    header = {"version": 1, "msg_type": tname, "flags": [n for i, n in enumerate(HEADER_FLAGS) if flags & (1 << i)],
              "event_count": count, "seq": seq, "timestamp_us": ts, "payload_length": plen}
    r = _Reader(buf, 24)
    out: dict[str, Any] = {"header": header}
    if tname == "DATA":
        out["events"] = _decode_events(r, count, ts, d)
        if r.remaining:
            raise AvpError("E_LENGTH", "Event Count 만큼 읽은 뒤 바이트가 남음")
    elif tname == "ACK":
        # 클라이언트 ACK 는 페이로드가 비어 있음
        if r.remaining:
            out["ack"] = {"frame_crc32": f"{r.u32():08X}", "decoded_events": r.uvar()}
        _no_trailing(r, "ACK")
    elif tname == "CONTROL":
        sub = r.u8()
        if r.remaining > MAX_CONTROL_BODY:
            raise AvpError("E_CONTROL_TOO_LARGE")
        if sub not in CONTROLS:
            # 모르는 subtype 은 비치명 E_SUBTYPE 이라 세션이 정함. 디코더는 본문을 그대로 넘김
            out["control"] = {"subtype": sub, "body_hex": r.take(r.remaining).hex().upper()}
        else:
            c: dict[str, Any] = {"subtype": SUBTYPES[sub]}
            _read_fields(r, CONTROLS[sub], c, d)
            if sub == 1 and c["proto_minor"] < 2:
                raise AvpError("E_VERSION", f"proto_minor {c['proto_minor']}")
            if r.remaining:
                # 끝 바이트는 무시하지만, 확장을 시험하는 쪽이 다시 계산하지 않게 시작 위치를 알려 줌
                c["trailing_offset"] = r.i
            out["control"] = c
    elif tname == "INFERENCE_RESULT":
        res: dict[str, Any] = {}
        _read_fields(r, RESULT_LAYOUT, res, d)
        if r.remaining:
            res["first_event_seq"], res["last_event_seq"] = r.uvar(), r.uvar()
        if r.remaining:
            res["ext"] = _read_ext(r)
        _no_trailing(r, "INFERENCE_RESULT")
        out["result"] = res
    elif tname == "MODEL_INPUT":
        wid, first, last, dtype, mflags, rows, cols = r.u32(), r.u32(), r.u32(), r.u8(), r.u8(), r.u16(), r.u16()
        if dtype != 1:
            raise AvpError("E_RANGE", f"모르는 dtype {dtype}")
        out["model_input"] = {"window_id": wid, "first_event_seq": first, "last_event_seq": last, "dtype": "f32",
                              "downsampled": bool(mflags & 1), "rows": rows, "cols": cols,
                              "data": [[r.f32() for _ in range(cols)] for _ in range(rows)]}
        _no_trailing(r, "MODEL_INPUT")
    elif tname == "STATE":
        st: dict[str, Any] = {}
        _read_fields(r, STATE_LAYOUT, st, d)
        _no_trailing(r, "STATE")
        out["state"] = st
    else:  # ASSET_CHUNK
        out["asset_chunk"] = {"challenge_id": r.str(), "asset_index": r.u8(), "chunk_index": r.u16(),
                              "chunk_count": r.u16(), "asset_size": r.u32(), "asset_sha256": r.take(32).hex(),
                              "data_hex": r.take(r.remaining).hex().upper()}
    return out


# ---------- 쓰기 ----------

def _int(v, lo: int, hi: int, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise _enc(f"{what} 범위 밖: {v!r}")
    return v


def _uvar(out: bytearray, n, what: str = "uvar") -> None:
    n = _int(n, 0, U32, what)
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def _svar(out: bytearray, n, what: str = "svar") -> None:
    n = _int(n, -(2**31), 2**31 - 1, what)
    _uvar(out, ((n << 1) ^ (n >> 31)) & U32)


def _f32(v, what: str) -> bytes:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise _enc(f"{what} 가 유한수가 아님: {v!r}")
    try:
        b = struct.pack("<f", v)
    except OverflowError:
        raise _enc(f"{what} 가 f32 범위 밖: {v!r}") from None
    if not math.isfinite(struct.unpack("<f", b)[0]):
        raise _enc(f"{what} 가 f32 범위 밖: {v!r}")
    return b


def _code(table: dict, v, what: str, size: int = 0xFF) -> int:
    if isinstance(v, str):
        for k, name in table.items():
            if name == v:
                return k
        raise _enc(f"{what} 에 없는 이름: {v}")
    return _int(v, 0, size, what)


def _str(out: bytearray, s, what: str, limit: int | None = None) -> None:
    if not isinstance(s, str):
        raise _enc(f"{what} 가 문자열이 아님")
    b = s.encode("utf-8")
    if "\x00" in s or (limit is not None and len(b) > limit):
        raise _enc(f"{what} 가 NUL 을 담거나 {limit}B 를 넘음")
    _uvar(out, len(b))
    out += b


def _json(out: bytearray, v, what: str) -> None:
    if not isinstance(v, dict):
        raise _enc(f"{what} 는 JSON 객체여야 함")
    try:
        b = json.dumps(v, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError) as e:
        raise _enc(f"{what} 를 JSON 으로 쓸 수 없음: {e}") from None
    if len(b) > MAX_JSON:
        raise _enc(f"{what} {len(b)}B 가 {MAX_JSON}B 를 넘음")
    _uvar(out, len(b))
    out += b


def _dict_index(d: dict | None, key: str, v, what: str) -> int:
    if isinstance(v, str):
        lst = (d or {}).get(key) or []
        if v in lst[1:]:
            return lst.index(v, 1)
        raise _enc(f"{what}: 사전 {key} 에 없는 값 {v}")
    return _int(v, 0, U32, what)


def _get(o: dict, k: str):
    if k not in o:
        raise _enc(f"필드 {k} 가 없음")
    return o[k]


def _write_fields(out: bytearray, layout: list, o: dict, d: dict | None) -> None:
    skipped_opt = False
    for spec in layout:
        name, kind = spec[0], spec[1]
        arg = spec[2] if len(spec) > 2 else None
        if kind in ("u8", "u16", "u32", "u64"):
            hi = {"u8": 0xFF, "u16": 0xFFFF, "u32": U32, "u64": MAX_SAFE_INTEGER}[kind]
            v = _int(_get(o, name), 0, hi, name)
            out += struct.pack({"u8": "<B", "u16": "<H", "u32": "<I", "u64": "<Q"}[kind], v)
        elif kind == "opt":
            # 묶음의 첫 필드가 있으면 묶음 전체를 씀. 나머지가 빠졌으면 _get 이 E_ENCODE
            if o.get(arg[0][0]) is not None:
                if skipped_opt:
                    raise _enc(f"{arg[0][0]} 앞 선택 묶음이 빠짐")
                _write_fields(out, arg, o, d)
            else:
                skipped_opt = True
        elif kind == "uvar":
            _uvar(out, _get(o, name), name)
        elif kind == "opt_uvar":
            if o.get(name) is not None:
                _uvar(out, o[name], name)
        elif kind == "svar":
            _svar(out, _get(o, name), name)
        elif kind == "enum":
            out.append(_code(arg, _get(o, name), name))
        elif kind == "enum16":
            out += struct.pack("<H", _code(arg, _get(o, name), name, 0xFFFF))
        elif kind == "bool":
            out.append(1 if _get(o, name) else 0)
        elif kind == "trusted":
            out.append(1 if _get(o, name) else 0)
        elif kind == "keyflags":
            out.append((1 if _get(o, "trusted") else 0) | (2 if _get(o, "repeat") else 0)
                       | (4 if _get(o, "is_composing") else 0))
        elif kind == "cpflags":
            pt = _code(POINTER_TYPE, _get(o, "pointer_type"), "pointer_type", 3)
            out.append((1 if _get(o, "pointer_known") else 0) | (2 if _get(o, "doc_visible") else 0)
                       | (4 if _get(o, "window_focused") else 0) | (pt << 3))
        elif kind == "bits":
            bits = 0
            for n in _get(o, name):
                if n not in arg:
                    raise _enc(f"{name} 에 없는 이름: {n}")
                bits |= 1 << arg.index(n)
            out.append(bits)
        elif kind == "target":
            v = _get(o, name)
            _uvar(out, 0 if v is None else v, name)
        elif kind == "dictref":
            v = _get(o, name)
            _uvar(out, 0 if v is None else _dict_index(d, arg, v, name), name)
        elif kind == "route":
            v = _get(o, name)
            _uvar(out, 0 if v is None else _dict_index(d, "routes", v, name) << 1 if isinstance(v, str) else v, name)
        elif kind == "bbox":
            b = _get(o, name)
            if not isinstance(b, list) or len(b) != 4:
                raise _enc(f"{name} 는 [x, y, w, h]")
            _svar(out, b[0], name)
            _svar(out, b[1], name)
            _uvar(out, b[2], name)
            _uvar(out, b[3], name)
        elif kind == "wheel":
            v = _get(o, name)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise _enc(f"{name} 가 수가 아님")
            # TS Math.round 와 같게 0.5 는 위로 올림
            _svar(out, math.floor(v * 100 + 0.5), name)
        elif kind == "str":
            _str(out, _get(o, name), name, arg)
        elif kind == "cutstr":
            # ERROR message: 오류를 알리는 일이 길이 때문에 실패하지 않게 바이트 한도 안에서 글자 경계로 자름
            v = _get(o, name)
            if not isinstance(v, str):
                raise _enc(f"{name} 가 문자열이 아님")
            _str(out, v.encode("utf-8")[:arg].decode("utf-8", "ignore"), name, arg)
        elif kind == "hex16":
            try:
                b = bytes.fromhex(_get(o, name))
            except (ValueError, TypeError):
                raise _enc(f"{name} 가 hex 가 아님") from None
            if len(b) != 16:
                raise _enc(f"{name} 는 16바이트")
            out += b
        elif kind == "json":
            _json(out, _get(o, name), name)
        elif kind == "score":
            v = _get(o, name)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= v <= 1.0:
                raise _enc(f"ai_score 가 0~1 이 아님: {v!r}")
            b = _f32(v, name)
            bits = o.get("ai_score_bits")
            if bits is not None and bits.upper() != f"{struct.unpack('<I', b)[0]:08X}":
                raise _enc(f"ai_score {v} 와 ai_score_bits {bits} 가 다름")
            out += b
        elif kind == "dicts":
            dicts = _get(o, name)
            if len(dicts) > 0xFF:
                raise _enc("사전 종류가 255개를 넘음")
            out.append(len(dicts))
            for key, lst in dicts.items():
                if key not in DICT_KINDS.values():
                    raise _enc(f"사전 종류 {key} 는 표 밖")
                code = _code(DICT_KINDS, key, "dict kind")
                if not lst or lst[0] != "" or len(lst) - 1 > 64:
                    raise _enc(f"사전 {key} 는 빈 문자열로 시작하고 항목 64개 이하")
                out.append(code)
                _uvar(out, len(lst) - 1)
                for s in lst[1:]:
                    _str(out, s, f"dict.{key}", 64)
        elif kind == "names":
            names = _get(o, name)
            if len(names) > 64:
                raise _enc("특징이 64개를 넘음")
            _uvar(out, len(names))
            for s in names:
                _str(out, s, name, 64)
        elif kind == "channels":
            chans = _get(o, name)
            if len(chans) > 8:
                raise _enc("채널이 8개를 넘음")
            _uvar(out, len(chans))
            for ch in chans:
                _str(out, _get(ch, "name"), "channel name", 64)
                _str(out, _get(ch, "unit"), "channel unit", 64)
        else:
            raise AssertionError(kind)


def _write_ext(out: bytearray, ext: dict) -> None:
    blocks: list[tuple[int, bytearray]] = []
    if "schema_id" in ext:
        b = bytearray()
        _uvar(b, ext["schema_id"], "schema_id")
        blocks.append((1, b))
    if "inference_time_us" in ext:
        b = bytearray()
        _uvar(b, ext["inference_time_us"], "inference_time_us")
        blocks.append((2, b))
    if "shape" in ext:
        b = bytearray()
        _uvar(b, _get(ext["shape"], "steps"), "steps")
        _uvar(b, _get(ext["shape"], "features"), "features")
        blocks.append((3, b))
    if "features" in ext:
        fs = ext["features"]
        if len(fs) > 64:
            raise _enc("features 가 64개를 넘음")
        b = bytearray()
        _uvar(b, len(fs))
        for f in fs:
            _uvar(b, _get(f, "id"), "feature id")
            b += _f32(_get(f, "value"), "feature value")
        blocks.append((4, b))
    if "series" in ext:
        s = ext["series"]
        npt, chans = _get(s, "points"), _get(s, "channels")
        if len(chans) > 8 or _int(npt, 0, 128, "points") > 128:
            raise _enc("series 는 채널 8개, 점 128개까지")
        b = bytearray([len(chans)])
        b += struct.pack("<H", npt)
        for ch in chans:
            _uvar(b, _get(ch, "id"), "channel id")
            b += _f32(_get(ch, "scale"), "scale") + _f32(_get(ch, "offset"), "offset")
            q = _get(ch, "q")
            if len(q) != npt:
                raise _enc("q 길이가 points 와 다름")
            for x in q:
                b += struct.pack("<h", _int(x, -32768, 32767, "q"))
        blocks.append((5, b))
    out.append(len(blocks))
    for tag, b in blocks:
        out.append(tag)
        _uvar(out, len(b))
        out += b


def encode_event(e: dict, prev_us: int, d: dict | None = None) -> bytes:
    """이벤트 하나를 type + length + payload 로. prev_us 는 dt 의 기준 시각"""
    t = _get(e, "t_us")
    name = _get(e, "event_type")
    if name == "UNKNOWN":
        code = _int(_get(e, "type_code"), 0, 0xFF, "type_code")
        if code in EVENTS:
            raise _enc(f"type_code 0x{code:02X} 는 등록된 이벤트")
        try:
            body = bytes.fromhex(_get(e, "raw"))
        except (ValueError, TypeError):
            raise _enc("raw 가 hex 가 아님") from None
        try:
            dt = _Reader(body).svar()
        except AvpError:
            raise _enc("raw 가 dt 로 시작하지 않음") from None
        if dt != t - prev_us:
            raise _enc(f"raw 의 dt {dt} 가 t_us 차이 {t - prev_us} 와 다름")
    else:
        if name not in EVENT_CODES:
            raise _enc(f"인코드할 수 없는 이벤트 {name}")
        code = EVENT_CODES[name]
        b = bytearray()
        _svar(b, t - prev_us, "dt")
        _write_fields(b, EVENTS[code][1], e, d)
        body = bytes(b)
    if len(body) > MAX_EVENT_PAYLOAD:
        raise _enc(f"이벤트 payload {len(body)}B")
    head = bytearray([code])
    _uvar(head, len(body))
    return bytes(head) + body


def build_frame(mtype: int, flags: int, count: int, seq: int, ts_us: int, payload: bytes) -> bytes:
    if len(payload) > MAX_PAYLOAD:
        raise _enc(f"페이로드 {len(payload)}B")
    _int(count, 0, MAX_EVENTS_PER_FRAME if mtype == 1 else 0, "event_count")
    _int(seq, 0, U32, "seq")
    _int(ts_us, 0, MAX_SAFE_INTEGER, "timestamp_us")
    return HEADER.pack(b"AV", 1, mtype, flags, count, seq, ts_us, len(payload)) + payload


def _encode_events(events: list, ts: int, d: dict | None) -> bytes:
    if len(events) > MAX_EVENTS_PER_FRAME:
        raise _enc(f"이벤트 {len(events)}개")
    if events and events[0].get("event_type") != "CHECKPOINT":
        raise _enc("비어 있지 않은 DATA 의 첫 이벤트는 CHECKPOINT")
    payload = bytearray()
    prev = ts
    first_seq = 0
    for k, e in enumerate(events):
        if k == 0:
            first_seq = _int(_get(e, "event_seq"), 0, U32, "event_seq")
        else:
            # event_seq 는 첫 CHECKPOINT 기준 순번. 다른 값을 주면 디코드 결과와 어긋나므로 거절
            want = first_seq + k
            if e.get("event_seq") is not None and e["event_seq"] != want:
                raise _enc(f"{k}번째 이벤트 event_seq {e['event_seq']} 가 {want} 가 아님")
            if e["event_type"] == "CHECKPOINT":
                e = {**e, "event_seq": want}
        payload += encode_event(e, prev, d)
        prev = e["t_us"]
    return bytes(payload)


def encode_frame(f: dict, d: dict | None = None) -> bytes:
    """디코드 결과와 같은 모양의 객체를 프레임으로. event_count, payload_length 는 다시 계산함"""
    h = _get(f, "header")
    tname = _get(h, "msg_type")
    if tname not in MSG_TYPES[1:]:
        raise _enc(f"모르는 msg_type {tname}")
    mtype = MSG_TYPES.index(tname)
    flags = 0
    for n in h.get("flags", []):
        if n not in HEADER_FLAGS:
            raise _enc(f"모르는 플래그 {n}")
        flags |= 1 << HEADER_FLAGS.index(n)
    seq, ts = _get(h, "seq"), _get(h, "timestamp_us")
    out = bytearray()
    count = 0
    if tname == "DATA":
        events = f.get("events") or []
        count = len(events)
        out += _encode_events(events, ts, d)
    elif tname == "ACK":
        a = f.get("ack")
        if a is not None:
            try:
                crc = int(_get(a, "frame_crc32"), 16)
            except (ValueError, TypeError):
                raise _enc("frame_crc32 가 hex 가 아님") from None
            out += struct.pack("<I", _int(crc, 0, U32, "frame_crc32"))
            _uvar(out, _get(a, "decoded_events"), "decoded_events")
    elif tname == "CONTROL":
        c = _get(f, "control")
        sub = c["subtype"]
        if isinstance(sub, str):
            if sub not in SUBTYPE_CODES:
                raise _enc(f"모르는 subtype {sub}")
            out.append(SUBTYPE_CODES[sub])
            _write_fields(out, CONTROLS[SUBTYPE_CODES[sub]], c, d)
        else:
            out.append(_int(sub, 0, 0xFF, "subtype"))
            out += bytes.fromhex(c.get("body_hex", ""))
        if len(out) - 1 > MAX_CONTROL_BODY:
            raise _enc(f"CONTROL body {len(out) - 1}B")
    elif tname == "INFERENCE_RESULT":
        res = _get(f, "result")
        _write_fields(out, RESULT_LAYOUT, res, d)
        has_range = res.get("first_event_seq") is not None
        if res.get("ext") is not None and not has_range:
            raise _enc("확장 블록 앞에 이벤트 번호 범위가 있어야 함")
        if has_range:
            _uvar(out, res["first_event_seq"], "first_event_seq")
            _uvar(out, _get(res, "last_event_seq"), "last_event_seq")
        if res.get("ext") is not None:
            _write_ext(out, res["ext"])
    elif tname == "MODEL_INPUT":
        m = _get(f, "model_input")
        if m.get("dtype", "f32") != "f32":
            raise _enc("dtype 은 f32 만")
        rows, cols, data = _get(m, "rows"), _get(m, "cols"), _get(m, "data")
        if len(data) != rows or any(len(row) != cols for row in data) or rows * cols * 4 > 65518:
            raise _enc("data 가 rows × cols 와 다르거나 65,518B 를 넘음")
        out += struct.pack("<IIIBBHH", _int(_get(m, "window_id"), 0, U32, "window_id"),
                           _int(_get(m, "first_event_seq"), 0, U32, "first_event_seq"),
                           _int(_get(m, "last_event_seq"), 0, U32, "last_event_seq"), 1,
                           1 if m.get("downsampled") else 0, _int(rows, 0, 0xFFFF, "rows"),
                           _int(cols, 0, 0xFFFF, "cols"))
        for row in data:
            for x in row:
                out += _f32(x, "data")
    elif tname == "STATE":
        _write_fields(out, STATE_LAYOUT, _get(f, "state"), d)
    else:
        a = _get(f, "asset_chunk")
        _str(out, _get(a, "challenge_id"), "challenge_id")
        out += struct.pack("<BHHI", _int(_get(a, "asset_index"), 0, 0xFF, "asset_index"),
                           _int(_get(a, "chunk_index"), 0, 0xFFFF, "chunk_index"),
                           _int(_get(a, "chunk_count"), 0, 0xFFFF, "chunk_count"),
                           _int(_get(a, "asset_size"), 0, U32, "asset_size"))
        try:
            sha, data = bytes.fromhex(_get(a, "asset_sha256")), bytes.fromhex(_get(a, "data_hex"))
        except (ValueError, TypeError):
            raise _enc("asset_sha256 이나 data_hex 가 hex 가 아님") from None
        if len(sha) != 32:
            raise _enc("asset_sha256 은 32바이트")
        out += sha + data
    return build_frame(mtype, flags, count, seq, ts, bytes(out))
