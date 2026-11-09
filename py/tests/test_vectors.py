import hashlib
import json
import struct
import zlib
from pathlib import Path

import pytest

from avp1 import AvpError, decode_frame, encode_frame

FILE = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-v0.2.json").read_text(encoding="utf-8"))
DICT = FILE["dict"]
F32 = set(FILE["compare"]["f32_fields"])
BY_ID = {v["id"]: v for v in FILE["vectors"]}


def _hex(s: str) -> bytes:
    return bytes.fromhex(s.replace(" ", ""))


def _f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def norm(o, f32=False):
    """명세 비교 규칙: f32 필드는 양쪽을 f32로 반올림한 뒤 비교"""
    if isinstance(o, dict):
        return {k: norm(v, f32 or k in F32) for k, v in o.items()}
    if isinstance(o, list):
        return [norm(v, f32) for v in o]
    if f32 and isinstance(o, (int, float)) and not isinstance(o, bool):
        return _f32(o)
    return o


def test_file_has_tv1_to_tv22():
    assert [v["id"] for v in FILE["vectors"]] == [f"TV{n}" for n in range(1, 23)]


@pytest.mark.parametrize("v", FILE["vectors"], ids=lambda v: v["id"])
def test_decode(v):
    buf = _hex(v["hex"])
    if "error" in v:
        with pytest.raises(AvpError) as e:
            decode_frame(buf, DICT)
        assert e.value.code == v["error"]
    else:
        assert norm(decode_frame(buf, DICT)) == norm(v["expected"])


@pytest.mark.parametrize("v", [v for v in FILE["vectors"] if "expected" in v], ids=lambda v: v["id"])
def test_encode(v):
    assert encode_frame(v.get("encode_input", v["expected"]), DICT).hex(" ").upper() == v["hex"]


def test_tv7_crc_is_crc_of_tv5_frame():
    tv5 = _hex(BY_ID["TV5"]["hex"])
    assert decode_frame(_hex(BY_ID["TV7"]["hex"]))["ack"] == {"frame_crc32": f"{zlib.crc32(tv5):08X}", "decoded_events": 3}


def test_tv12_sha256_matches_data():
    chunk = decode_frame(_hex(BY_ID["TV12"]["hex"]))["asset_chunk"]
    assert hashlib.sha256(bytes.fromhex(chunk["data_hex"])).hexdigest() == chunk["asset_sha256"]


def test_tv6_unknown_event_keeps_dt():
    events = decode_frame(_hex(BY_ID["TV6"]["hex"]), DICT)["events"]
    assert events[2]["t_us"] == 6_006_000


EXTRA = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-v0.2-extra.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("v", EXTRA["vectors"], ids=lambda v: v["id"])
def test_extra_decode(v):
    buf = _hex(v["hex"])
    if "error" in v:
        with pytest.raises(AvpError) as e:
            decode_frame(buf, DICT)
        assert e.value.code == v["error"]
    else:
        assert decode_frame(buf, DICT) == v["expected"]


@pytest.mark.parametrize("v", [v for v in EXTRA["vectors"] if "expected" in v and v.get("encode", True)],
                         ids=lambda v: v["id"])
def test_extra_encode(v):
    assert encode_frame(v["expected"], DICT).hex(" ").upper() == v["hex"]


def test_text_message_is_magic_error():
    with pytest.raises(AvpError) as e:
        decode_frame("hello")
    assert e.value.code == "E_MAGIC"


V3 = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-v0.3.json").read_text(encoding="utf-8"))


def test_v03_file_has_tv23_to_tv35():
    assert [v["id"] for v in V3["vectors"]] == [f"TV{n}" for n in range(23, 36)]


@pytest.mark.parametrize("v", V3["vectors"], ids=lambda v: v["id"])
def test_v03_decode(v):
    assert norm(decode_frame(_hex(v["hex"]), V3["dict"])) == norm(v["expected"])


@pytest.mark.parametrize("v", [v for v in V3["vectors"] if v.get("encode", True)], ids=lambda v: v["id"])
def test_v03_encode(v):
    assert encode_frame(v.get("encode_input", v["expected"]), V3["dict"]).hex(" ").upper() == v["hex"]


FUZZ = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-fuzz-findings.json").read_text(encoding="utf-8"))


def _at(o, path: str):
    for k in path.split("."):
        o = o[k]
    return o


@pytest.mark.parametrize("f", [f for f in FUZZ["findings"] if "check" in f], ids=lambda f: f["id"])
def test_fuzz_findings(f):
    buf, check = _hex(f["hex"]), f["check"]
    if "error" in check:
        with pytest.raises(AvpError) as e:
            decode_frame(buf, FUZZ["dict"])
        assert e.value.code == check["error"]
        return
    dec = decode_frame(buf, FUZZ["dict"])
    if "field" in check and "value_json" in check:
        assert _at(dec, check["field"]) == check["value_json"]
    elif "field" in check:
        assert _at(dec, check["field"]) == check["value"]
    if "also_error" in check:
        with pytest.raises(AvpError) as e:
            decode_frame(_hex(f["also_hex"]), FUZZ["dict"])
        assert e.value.code == check["also_error"]
    if check.get("reencode") == "same_hex":
        assert encode_frame(dec, FUZZ["dict"]).hex(" ").upper() == f["hex"]
    elif "reencode" in check:
        with pytest.raises(AvpError) as e:
            encode_frame(dec, FUZZ["dict"])
        assert e.value.code == check["reencode"]["error"]


V31 = json.loads((Path(__file__).parents[2] / "test-vectors" / "avp1-v0.3.1.json").read_text(encoding="utf-8"))


def test_v031_file_has_tv36_to_tv73():
    assert [v["id"] for v in V31["vectors"]] == [f"TV{n}" for n in range(36, 74)]


@pytest.mark.parametrize("v", V31["vectors"], ids=lambda v: v["id"])
def test_v031_decode(v):
    buf = _hex(v["hex"])
    if "error" in v:
        with pytest.raises(AvpError) as e:
            decode_frame(buf, V31["dict"])
        assert e.value.code == v["error"]
    else:
        assert norm(decode_frame(buf, V31["dict"])) == norm(v["expected"])


@pytest.mark.parametrize("v", [v for v in V31["vectors"] if "expected" in v and v.get("encode", True)],
                         ids=lambda v: v["id"])
def test_v031_encode(v):
    assert encode_frame(v["expected"], V31["dict"]).hex(" ").upper() == v["hex"]
