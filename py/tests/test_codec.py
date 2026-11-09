import pytest

from avp1 import AvpError, build_frame, decode_frame, encode_frame


def _change_order(params: bytes) -> bytes:
    # anchor 1, reorder, target_av 1, deadline 1000ms, 경로 무관 뒤에 params
    body = b"\x03\x01\x01\x01\xe8\x07\x00" + bytes([len(params) & 0x7F | 0x80, len(params) >> 7]) + params
    return build_frame(3, 0, 0, 1, 0, body)


def test_deeply_nested_json_is_control_body_error():
    # 2,048B 안에 들어가지만 json 파서의 재귀 한도를 넘는 깊이
    with pytest.raises(AvpError) as e:
        decode_frame(_change_order(b"[" * 1000 + b"]" * 1000))
    assert e.value.code == "E_CONTROL_BODY"


def test_json_field_over_2048_bytes():
    params = b'{"a":"' + b"x" * 2043 + b'"}'
    assert len(params) == 2051
    with pytest.raises(AvpError) as e:
        decode_frame(_change_order(params))
    assert e.value.code == "E_CONTROL_TOO_LARGE"


def test_control_body_over_8192_bytes():
    with pytest.raises(AvpError) as e:
        decode_frame(build_frame(3, 0, 0, 1, 0, b"\x80" + b"\x00" * 8193))
    assert e.value.code == "E_CONTROL_TOO_LARGE"


def test_json_nan_literal_rejected():
    with pytest.raises(AvpError) as e:
        decode_frame(_change_order(b'{"a":NaN}'))
    assert e.value.code == "E_CONTROL_BODY"


def _header(t):
    return {"version": 1, "msg_type": t, "flags": [], "event_count": 0, "seq": 1, "timestamp_us": 0, "payload_length": 0}


@pytest.mark.parametrize("frame", [
    {"header": _header("INFERENCE_RESULT"),
     "result": {"window_id": 1, "window_start_ms": 0, "window_end_ms": 1, "event_count": 1, "ai_score": 1.01}},
    {"header": _header("INFERENCE_RESULT"),
     "result": {"window_id": 1, "window_start_ms": 0, "window_end_ms": 1, "event_count": 1, "ai_score": 0.5,
                "ext": {"schema_id": 1}}},
    {"header": _header("STATE"), "state": {"state": "NOPE", "reason": "none", "window_id": 0}},
    {"header": _header("CONTROL"), "control": {"subtype": "STOP", "reason": 256}},
    {"header": {**_header("DATA"), "msg_type": "DATA"},
     "events": [{"t_us": 0, "event_type": "POINTER_MOVE", "dx": 1, "dy": 1}]},
])
def test_encoder_rejects_out_of_range(frame):
    with pytest.raises(AvpError) as e:
        encode_frame(frame)
    assert e.value.code == "E_ENCODE"


def test_wheel_half_rounds_up_like_ts():
    cp = {"t_us": 0, "event_seq": 1, "event_type": "CHECKPOINT", "pointer_known": False, "doc_visible": True,
          "window_focused": True, "pointer_type": "mouse", "x": 0, "y": 0, "scroll_y": 0, "anchor": 0}
    wheel = {"t_us": 0, "event_type": "WHEEL", "wheel_dx": 0.125, "wheel_dy": -0.125, "wheel_delta_mode": "pixel",
             "target": None}
    got = decode_frame(encode_frame({"header": _header("DATA"), "events": [cp, wheel]}))["events"][1]
    # 12.5 -> 13, -12.5 -> -12 (Math.round 와 같음)
    assert (got["wheel_dx"], got["wheel_dy"]) == (0.13, -0.12)


def _ctl(c, seq=1):
    return {"header": _header("CONTROL") | {"seq": seq}, "control": c}


def test_close_codes_follow_error_table():
    from avp1 import CLOSE_CODES
    from avp1.codec import ERROR_CODES

    assert set(CLOSE_CODES) == set(ERROR_CODES.values())
    assert CLOSE_CODES["E_SUBTYPE"] is None
    assert (CLOSE_CODES["E_STATE"], CLOSE_CODES["E_VERSION"], CLOSE_CODES["E_HELLO_REQUIRED"]) == (4422, 4426, 4401)
    assert (CLOSE_CODES["E_FRAME_TOO_LARGE"], CLOSE_CODES["E_CLIENT_KEY"], CLOSE_CODES["E_INTERNAL"]) == (4413, 4403, 1011)


@pytest.mark.parametrize("msg, want", [
    ("a" * 256, "a" * 256),           # 한도 그대로
    ("a" * 257, "a" * 256),           # ASCII 는 256바이트에서 자름
    ("a" * 255 + "가", "a" * 255),     # 글자 중간에서 자르지 않음
    ("😀" * 70, "😀" * 64),            # 4바이트 글자
    ("", ""),
])
def test_error_message_is_cut_to_256_bytes_on_char_boundary(msg, want):
    raw = encode_frame(_ctl({"subtype": "ERROR", "code": "E_STATE", "fatal": True, "message": msg}))
    assert decode_frame(raw)["control"]["message"] == want


def test_control_without_trailing_bytes_has_no_trailing_offset():
    raw = encode_frame(_ctl({"subtype": "STOP", "reason": "limit"}))
    assert "trailing_offset" not in decode_frame(raw)["control"]


def test_welcome_v03_group_needs_both_fields():
    base = {"subtype": "WELCOME", "session_id": "00" * 16, "server_open_unix_us": 0, "caps": 0, "server_flags": 0,
            "flush_ms": 50, "keepalive_ms": 15000, "infer_interval_ms": 1000, "window_ms": 10000,
            "min_action_events": 3, "captcha_threshold_milli": 800, "captcha_sustain_ms": 10000,
            "max_payload_bytes": 65536, "max_events_per_frame": 1024, "max_unacked_frames": 64, "dict": {}}
    with pytest.raises(AvpError) as e:
        encode_frame(_ctl({**base, "block_threshold_milli": 900}))
    assert e.value.code == "E_ENCODE"
    with pytest.raises(AvpError) as e:
        encode_frame(_ctl({**base, "block_threshold_milli": 70000, "captcha_trigger": "protected_action"}))
    assert e.value.code == "E_ENCODE"
    got = decode_frame(encode_frame(_ctl({**base, "block_threshold_milli": 0, "captcha_trigger": 2})))["control"]
    assert (got["block_threshold_milli"], got["captcha_trigger"]) == (0, "both")


def test_build_frame_rejects_event_count_over_limit_and_on_non_data():
    # v0.3.1 A14: 인코더도 프레임당 이벤트 1,024개 한도와 DATA 밖 Event Count 0 을 지킴
    from avp1.codec import build_frame
    with pytest.raises(AvpError) as e:
        build_frame(1, 0, 1025, 1, 0, b"")
    assert e.value.code == "E_ENCODE"
    with pytest.raises(AvpError) as e:
        build_frame(6, 0, 1, 1, 0, bytes(6))
    assert e.value.code == "E_ENCODE"
    assert len(build_frame(1, 0, 1024, 1, 0, b"")) == 24


def test_state_token_bundle_needs_event_seq_bundle():
    # 뒤 선택 묶음만 쓸 수 없음(선택 필드와 확장 규칙)
    from avp1 import encode_frame
    with pytest.raises(AvpError) as e:
        encode_frame({"header": {"msg_type": "STATE", "flags": [], "seq": 1, "timestamp_us": 0},
                      "state": {"state": "SCORING", "reason": "action_allowed", "window_id": 1,
                                "action_token": "00" * 16}})
    assert e.value.code == "E_ENCODE"
