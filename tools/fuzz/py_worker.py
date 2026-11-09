"""차등 퍼저의 Python 쪽 일꾼. fuzz.py 가 띄우고 표준 입력으로 hex 를 한 줄씩 보냅니다.

한 줄에 하나씩 디코드하고, 성공하면 다시 인코드해 원래 바이트와 비교한 결과를 JSON 한 줄로 돌려줍니다.
디코더가 멈추거나 느려지는지는 부르는 쪽이 시간 제한으로 봅니다.
"""

from __future__ import annotations

import json
import math
import sys
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py"))

from avp1.codec import AvpError, decode_frame, encode_frame  # noqa: E402

DICT = json.loads((ROOT / "test-vectors" / "avp1-v0.2.json").read_text(encoding="utf-8"))["dict"]
MAX_SAFE = 2**53 - 1


def _unsafe(o, path: str, out: list[str]) -> None:
    """TS 가 같은 값으로 담을 수 없는 수(2^53 밖 정수, 유한수가 아닌 실수)의 위치. 비교가 이 차이를 놓치지 않게 따로 알림"""
    if isinstance(o, bool):
        return
    if isinstance(o, int) and abs(o) > MAX_SAFE:
        out.append(path)
    elif isinstance(o, float) and not math.isfinite(o):
        out.append(path)
    elif isinstance(o, dict):
        for k, v in o.items():
            _unsafe(v, f"{path}.{k}", out)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            _unsafe(v, f"{path}[{i}]", out)


def _json_safe(o):
    if isinstance(o, float) and not math.isfinite(o):
        return repr(o)
    if isinstance(o, dict):
        return {k: _json_safe(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_json_safe(v) for v in o]
    return o


def _value(dec: dict) -> dict:
    """길이 정보(payload_length, trailing_offset)를 뺀 디코드 값. 남는 바이트를 버린 재인코드가 같은 값인지 볼 때 씀"""
    out = {**dec, "header": {k: v for k, v in dec["header"].items() if k != "payload_length"}}
    if "control" in out:
        out["control"] = {k: v for k, v in out["control"].items() if k != "trailing_offset"}
    return out


def run_one(buf: bytes) -> dict:
    tracemalloc.reset_peak()
    t0 = time.perf_counter()
    res: dict = {}
    try:
        dec = decode_frame(buf, DICT)
    except AvpError as e:
        res = {"ok": False, "code": e.code}
    except Exception as e:  # 규격 오류가 아닌 예외는 모두 버그 후보라 이름째 넘김
        res = {"ok": False, "exc": f"{type(e).__name__}: {e}"[:300]}
    else:
        unsafe: list[str] = []
        _unsafe(dec, "$", unsafe)
        res = {"ok": True, "decoded": _json_safe(dec)}
        if unsafe:
            res["unsafe"] = unsafe
        try:
            re = encode_frame(dec, DICT)
        except AvpError as e:
            res["reenc_err"] = str(e)
        except Exception as e:
            res["reenc_exc"] = f"{type(e).__name__}: {e}"[:300]
        else:
            res["reenc"] = re.hex().upper()
            if re != buf:
                try:
                    res["redecode_same"] = _value(decode_frame(re, DICT)) == _value(dec)
                except AvpError as e:
                    res["redecode_same"] = False
                    res["redecode_err"] = e.code
    res["ms"] = (time.perf_counter() - t0) * 1000
    res["mem_mb"] = tracemalloc.get_traced_memory()[1] / 2**20
    return res


def main() -> None:
    tracemalloc.start()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        # 빈 프레임은 빈 줄과 구별하려고 "-" 로 받음
        r = run_one(b"" if line == "-" else bytes.fromhex(line))
        # json 안 "\ud800" 같은 짝 없는 서로게이트가 디코드 값에 남을 수 있어 UTF-8 이 아니라 ASCII 이스케이프로 씀
        out.write(json.dumps(r, allow_nan=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
