"""AVP/1 TS 와 Python 디코더 차등 퍼저.

    python tools/fuzz/fuzz.py --total 20000 --report out.json     전체 판
    python tools/fuzz/fuzz.py --total 1000                          시험 스위트의 짧은 판(ts/test/fuzz.test.ts)

같은 입력을 두 디코더(py/avp1/codec.py, ts/src/codec.ts)에 넣고 아래를 봅니다.
- 둘 다 성공: 디코드 결과가 같아야 함(f32 필드는 명세 비교 규칙대로 f32 로 반올림해 비교)
- 둘 다 실패: 오류 코드가 같고 명세 오류 코드 표에 있어야 함
- 한쪽만 성공: 불일치
- 규격 오류가 아닌 예외, 1초 넘는 처리, 5초 안에 답이 없음(멈춤), 메모리 64MB 초과: 버그
- 성공하면 다시 인코드: 원래 바이트와 같거나, 다르면 다시 디코드한 값이 같아야 함(정규형이 아닌 입력)

입력은 네 범주이고 시드가 같으면 같은 입력이 나옵니다.
  mutate    골든 벡터 hex 를 뒤집기, 삽입, 삭제, 자르기, 길이 필드 조작, varint 늘리기로 바꿈
  random    무작위 바이트
  header_ok 검사 순서 1~10단계를 통과하는 헤더 + 무작위 본문
  boundary  명세 한도 표의 최대와 최대+1

결과에서 '규격 결정 필요'나 '규격이 허용'으로 test-vectors/avp1-fuzz-findings.json 에 적힌 signatures 는 실패로 세지 않습니다.
종료 코드는 그 밖의 버그나 불일치가 하나라도 있으면 1입니다.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import random
import struct
import subprocess
import sys
import threading
import time
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "py"))

from avp1.codec import ERROR_CODES, encode_frame  # noqa: E402

VEC = ROOT / "test-vectors"
FINDINGS = VEC / "avp1-fuzz-findings.json"
F32_FIELDS = set(json.loads((VEC / "avp1-v0.3.json").read_text(encoding="utf-8"))["compare"]["f32_fields"])
DICT = json.loads((VEC / "avp1-v0.2.json").read_text(encoding="utf-8"))["dict"]
SPEC_CODES = set(ERROR_CODES.values())
SLOW_MS = 1000
HANG_S = 5
MEM_MB = 64
# 이 종류는 명세가 허용하는 모양이거나(정규형이 아닌 입력) 코덱이 다시 쓸 수 없는 것으로 정해 둔 모양이라 실패로 세지 않음
BENIGN = {"rt_noncanonical", "rt_skip_unknown", "rt_checkpoint_seq"}


# ---------- 일꾼 ----------

class Worker:
    """표준 입출력으로 hex 한 줄을 주고 JSON 한 줄을 받는 일꾼. 답이 HANG_S 안에 없으면 죽이고 다시 띄움"""

    def __init__(self, name: str, cmd: list[str], cwd: Path, ready: bool):
        self.name, self.cmd, self.cwd, self.ready = name, cmd, cwd, ready
        self._start()

    def _start(self) -> None:
        self.p = subprocess.Popen(self.cmd, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
                                  env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.q: queue.Queue[str] = queue.Queue()
        # stderr 를 비워 두지 않으면 파이프가 차서 일꾼이 멈출 수 있음. 죽었을 때 보여 줄 끝부분만 남김
        self.err: deque[str] = deque(maxlen=50)
        threading.Thread(target=self._pump, args=(self.p, self.q), daemon=True).start()
        threading.Thread(target=self._drain, args=(self.p, self.err), daemon=True).start()
        if self.ready:
            line = self.q.get(timeout=120)
            if line.strip() != "ready":
                raise RuntimeError(f"{self.name} 일꾼이 뜨지 않음: {line!r} {''.join(self.err)}")

    @staticmethod
    def _pump(p: subprocess.Popen, q: queue.Queue) -> None:
        assert p.stdout
        for line in p.stdout:
            q.put(line)
        q.put("")

    @staticmethod
    def _drain(p: subprocess.Popen, err: deque) -> None:
        assert p.stderr
        for line in p.stderr:
            err.append(line)

    def call(self, h: str) -> dict:
        assert self.p.stdin
        try:
            self.p.stdin.write((h or "-") + "\n")
            self.p.stdin.flush()
            line = self.q.get(timeout=HANG_S)
        except (queue.Empty, BrokenPipeError, OSError):
            self.p.kill()
            self._start()
            return {"ok": False, "hang": True}
        if not line:
            err = "".join(self.err)
            self._start()
            return {"ok": False, "exc": f"일꾼이 죽음: {err[-300:]}"}
        return json.loads(line)

    def close(self) -> None:
        try:
            assert self.p.stdin
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def workers() -> tuple[Worker, Worker]:
    py = Worker("py", [sys.executable, str(ROOT / "tools" / "fuzz" / "py_worker.py")], ROOT, ready=False)
    ts = Worker("ts", ["node", str(ROOT / "ts" / "scripts" / "fuzz-worker.mjs")], ROOT / "ts", ready=True)
    return py, ts


# ---------- 비교 ----------

def _f32(x: float) -> float:
    return struct.unpack("<f", struct.pack("<f", x))[0]


def same(a, b, f32: bool = False) -> bool:
    """명세 비교 규칙대로 같은지. True 와 1 처럼 Python 이 같다고 보는 다른 형도 다르게 봄"""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a == b:
            return True
        try:
            return f32 and _f32(a) == _f32(b)
        except (OverflowError, struct.error):
            return False
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k], f32 or k in F32_FIELDS) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y, f32) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def first_diff(a, b, path: str = "$") -> str:
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(a) + [k for k in b if k not in a]:
            if k not in a or k not in b:
                return f"{path}.{k}"
            if not same(a[k], b[k], k in F32_FIELDS):
                return first_diff(a[k], b[k], f"{path}.{k}")
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            if not same(x, y):
                return first_diff(x, y, f"{path}[{i}]")
    return path


def _shape(dec: dict) -> str:
    """디코드 결과의 메시지 모양(종류와 CONTROL subtype). 같은 원인을 한 묶음으로 세는 데 씀"""
    t = dec["header"]["msg_type"]
    if t == "CONTROL":
        return f"CONTROL.{dec['control']['subtype']}"
    return t


def _nodigits(s: str) -> str:
    return "".join(c for c in s if not c.isdigit())


def _tags(dec: dict) -> str:
    """두 인코더가 다른 바이트를 쓰는 이유 가운데 명세가 이미 적은 것(json 실수 표기, 배열 번호 모양 키)과 사전 종류 숫자 이름"""
    tags = []

    def walk(o, in_json: bool) -> None:
        if isinstance(o, float) and in_json:
            tags.append("json_float")
        elif isinstance(o, dict):
            if in_json and any(k.isdigit() for k in o):
                tags.append("json_numeric_key")
            for v in o.values():
                walk(v, in_json)
        elif isinstance(o, list):
            for v in o:
                walk(v, in_json)

    c = dec.get("control", {})
    for k in ("params", "answer", "meta"):
        if k in c:
            walk(c[k], True)
    if any(k.isdigit() for k in c.get("dict", {})):
        tags.append("dict_numeric_kind")
    return ",".join(sorted(set(tags))) or "other"


def _rt(side: str, r: dict, buf: bytes) -> list[tuple[str, str]]:
    """다시 인코드 결과. (종류, signature 꼬리)"""
    dec = r["decoded"]
    if "reenc_exc" in r:
        return [("rt_crash", f"{side}|{_shape(dec)}|{r['reenc_exc'].split(':')[0]}")]
    if "reenc_err" in r:
        events = dec.get("events", [])
        if any(e.get("event_type") == "UNKNOWN" for e in events):
            return [("rt_skip_unknown", f"{side}|DATA")]
        if any(e["event_type"] == "CHECKPOINT" and e["event_seq"] != events[0]["event_seq"] + k
               for k, e in enumerate(events) if k):
            # 프레임 중간 CHECKPOINT 의 event_seq 가 자리 번호와 다르면 디코더는 받고 인코더는 거절(명세 골든 벡터 절)
            return [("rt_checkpoint_seq", f"{side}|DATA")]
        return [("rt_encode_error", f"{side}|{_shape(dec)}|{_nodigits(r['reenc_err'])[:60]}")]
    if r["reenc"] == buf.hex().upper():
        return []
    if r.get("redecode_same"):
        ob, rb = buf[24:], bytes.fromhex(r["reenc"])[24:]
        why = ("trailing" if ob.startswith(rb) else "shorter" if len(rb) < len(ob)
               else "same_length" if len(rb) == len(ob) else "longer")
        return [("rt_noncanonical", f"{side}|{_shape(dec)}|{why}")]
    return [("rt_semantic", f"{side}|{_shape(dec)}")]


def classify(buf: bytes, py: dict, ts: dict) -> list[tuple[str, str]]:
    """찾은 것 목록. 각각 (종류, signature)"""
    out: list[tuple[str, str]] = []
    for side, r in (("py", py), ("ts", ts)):
        if r.get("hang"):
            out.append(("hang", side))
        elif "exc" in r:
            out.append(("crash", f"{side}|{r['exc'].split(':')[0]}"))
        else:
            if r["ms"] > SLOW_MS:
                out.append(("slow", side))
            if r["mem_mb"] > MEM_MB:
                out.append(("memory", side))
            if not r["ok"] and r["code"] not in SPEC_CODES:
                out.append(("nonspec_code", f"{side}|{r['code']}"))
    if out:
        return out
    if py["ok"] and ts["ok"]:
        if not same(py["decoded"], ts["decoded"]):
            where = first_diff(py["decoded"], ts["decoded"])
            # 배열 번호는 묶음을 나누지 않게 지움
            out.append(("mismatch_decode", f"{_shape(py['decoded'])}|{_nodigits(where)}"))
        if "unsafe" in py:
            out.append(("unsafe_number", f"{_shape(py['decoded'])}|{_nodigits(py['unsafe'][0])}"))
        out += _rt("py", py, buf) + _rt("ts", ts, buf)
        if "reenc" in py and "reenc" in ts and py["reenc"] != ts["reenc"]:
            tag = "unsafe_number" if "unsafe" in py else _tags(py["decoded"])
            out.append(("mismatch_reencode", f"{_shape(py['decoded'])}|{tag}"))
    elif py["ok"] != ts["ok"]:
        ok, bad = ("py", ts) if py["ok"] else ("ts", py)
        shape = _shape((py if py["ok"] else ts)["decoded"])
        out.append(("mismatch_accept", f"{ok}_ok|{shape}|{bad['code']}"))
    elif py["code"] != ts["code"]:
        mt = buf[3] if len(buf) > 3 else -1
        out.append(("mismatch_code", f"type{mt}|py={py['code']}|ts={ts['code']}"))
    return out


# ---------- 입력 생성 ----------

HEADER = struct.Struct("<2sBBHHIQI")


def frame(mtype: int, body: bytes, *, flags: int = 0, count: int = 0, seq: int = 1, ts: int = 1000,
          plen: int | None = None) -> bytes:
    return HEADER.pack(b"AV", 1, mtype, flags, count, seq, ts, len(body) if plen is None else plen) + body


def uvar(n: int) -> bytes:
    out = bytearray()
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)


def fix_plen(b: bytes) -> bytes:
    if len(b) < 24:
        return b
    return b[:20] + struct.pack("<I", len(b) - 24) + b[24:]


def seeds() -> list[bytes]:
    out = []
    for name in ("avp1-v0.2.json", "avp1-v0.3.json", "avp1-v0.2-extra.json"):
        for v in json.loads((VEC / name).read_text(encoding="utf-8"))["vectors"]:
            out.append(bytes.fromhex(v["hex"].replace(" ", "")))
    return out


# 문자열과 json 필드에 넣어 보는 조각. UTF-8 경계(BOM, 긴 꼴, 서로게이트, U+10FFFF 초과), NUL,
# JSON 수의 정밀도와 범위(2^53 밖 정수, 1e400, -0), 공백, 이스케이프
TOKENS = [b"\xef\xbb\xbf", b"\xc0\x80", b"\xed\xa0\x80", b"\xf4\x90\x80\x80", b"\x00", b"\x80", b"\xe2\x82",
          b"\xc3\xa9", b"\xf0\x9f\x98\x80", b" ", b"\t", b'"z":9007199254740993,', b'"z":1e400,', b'"z":-0,',
          b'"z":1.0,', rb'"z":"\ud800",', rb'"z":"\u0000",', b'"9":1,', b'"__proto__":1,', b'"z":1E2,']


class Gen:
    def __init__(self, seed: int):
        self.r = random.Random(seed)
        self.seeds = seeds()

    def byte(self) -> int:
        # 작은 수와 varint 이어짐 바이트가 자주 나와야 본문 안쪽 분기까지 감
        x = self.r.random()
        if x < 0.45:
            return self.r.randrange(0, 16)
        if x < 0.6:
            return self.r.randrange(0x80, 0x90)
        if x < 0.65:
            return 0xFF
        return self.r.randrange(256)

    def rbytes(self, n: int) -> bytes:
        return bytes(self.byte() for _ in range(n))

    # (a) 골든 벡터 변형
    def mutate(self) -> bytes:
        r = self.r
        b = bytearray(r.choice(self.seeds))
        touched_len = False
        if r.random() < 0.25:
            # 다른 변형과 섞이면 앞 단계 검사에서 먼저 걸려 문자열 디코드까지 가지 못하므로 따로도 돌림
            self.str_token(b)
            return fix_plen(bytes(b))
        for _ in range(r.randrange(1, 4)):
            op = r.randrange(11)
            n = len(b)
            if op == 0 and n:  # 비트 뒤집기
                i = r.randrange(n)
                b[i] ^= 1 << r.randrange(8)
            elif op == 1 and n:  # 바이트 바꾸기
                b[r.randrange(n)] = self.byte()
            elif op == 2:  # 삽입
                i = r.randrange(n + 1)
                b[i:i] = self.rbytes(r.randrange(1, 9))
            elif op == 3 and n > 24:  # 삭제
                i = r.randrange(24, n)
                del b[i:i + r.randrange(1, 9)]
            elif op == 4 and n:  # 자르기
                del b[r.randrange(n):]
            elif op == 5 and n > 24:  # 조각 복제
                i = r.randrange(24, n)
                j = min(n, i + r.randrange(1, 16))
                b[j:j] = b[i:j]
            elif op == 6 and n >= 24:  # Payload Length 조작
                plen = struct.unpack_from("<I", b, 20)[0]
                plen = r.choice([0, min(0xFFFFFFFF, plen + 1), max(0, plen - 1), 65536, 65537, 0xFFFFFFFF, r.randrange(70000)])
                b[20:24] = struct.pack("<I", plen)
                touched_len = True
            elif op == 7 and n >= 24:  # Event Count 조작
                c = struct.unpack_from("<H", b, 6)[0]
                b[6:8] = struct.pack("<H", r.choice([0, min(0xFFFF, c + 1), max(0, c - 1), 1024, 1025, 0xFFFF]))
            elif op == 8 and n > 24:  # varint 늘리기: 끝 바이트에 이어짐 비트를 켜고 0x00 을 덧붙여 같은 값을 더 길게
                cands = [i for i in range(24, n) if b[i] < 0x80]
                if cands:
                    i = r.choice(cands)
                    k = r.randrange(1, 5)
                    b[i:i + 1] = bytes([b[i] | 0x80]) + b"\x80" * (k - 1) + b"\x00"
            elif op == 9 and n > 24:  # 길이로 쓰이는 작은 수를 늘리거나 줄임
                cands = [i for i in range(24, n) if b[i] < 0x40]
                if cands:
                    i = r.choice(cands)
                    b[i] = max(0, min(0x7F, b[i] + r.choice([-2, -1, 1, 2, 16])))
            elif op == 10:  # 문자열 필드 안에 까다로운 조각을 넣고 길이 바이트도 같이 늘림
                self.str_token(b)
        if not touched_len and r.random() < 0.7:
            b = bytearray(fix_plen(bytes(b)))
        return bytes(b)

    def str_token(self, b: bytearray) -> None:
        """길이 바이트 L 뒤에 출력 가능한 바이트 L 개가 이어지는 곳을 str 로 보고, 그 안에 TOKENS 하나를 넣음"""
        r = self.r
        cands = [i for i in range(24, len(b) - 1)
                 if 0 < b[i] < 0x60 and i + 1 + b[i] <= len(b) and all(0x20 <= x < 0x7F for x in b[i + 1:i + 1 + b[i]])]
        if not cands:
            return
        # 한 글자짜리 후보는 str 이 아닌 경우가 많아 긴 후보를 더 자주 고름. 디코더마다 다르게 다루기 쉬운 곳은 맨 앞(BOM)
        i = r.choices(cands, weights=[b[c] for c in cands])[0]
        tok = r.choice(TOKENS)
        at = i + 1 + r.choice([0, 0, 0, 1, b[i]] if b[i] > 1 else [0])
        b[at:at] = tok
        b[i] = min(0x7F, b[i] + len(tok))

    # (b) 무작위 바이트
    def random(self) -> bytes:
        r = self.r
        n = r.choice([r.randrange(0, 24), r.randrange(24, 64), r.randrange(64, 400)])
        b = bytes(r.randrange(256) for _ in range(n))
        if r.random() < 0.15:
            b = b"AV\x01" + b[3:]
        return b

    # (c) 헤더는 맞고 본문만 무작위
    def header_ok(self) -> bytes:
        r = self.r
        mtype = r.choice([1, 1, 1, 2, 3, 3, 3, 4, 4, 5, 6, 7])
        flags = r.randrange(32)
        count = 0
        n = r.choice([r.randrange(0, 12), r.randrange(12, 80), r.randrange(80, 600)])
        body = bytearray(self.rbytes(n))
        if mtype == 1:
            count = r.choice([0, r.randrange(1, 4), r.randrange(1, 40), 1024])
            if body and r.random() < 0.85:
                body[0] = 0x50
        elif mtype == 3 and body and r.random() < 0.9:
            body[0] = r.randrange(1, 13)
        elif mtype == 4 and r.random() < 0.5 and len(body) >= 17:
            body[13:17] = struct.pack("<f", r.random())  # ai_score 자리에 0~1 값을 넣어 뒤쪽 필드까지 가게
        ts = r.choice([r.randrange(2**32), r.randrange(2**53), 2**53 - 1])
        return frame(mtype, bytes(body), flags=flags, count=count, seq=r.randrange(2**32), ts=ts)

    # (d) 크기 상한 경계
    def boundary(self) -> bytes:
        r = self.r
        over = r.random() < 0.5  # 최대+1
        k = 1 if over else 0
        t = r.randrange(27)
        cp = bytes([0x50, 7]) + b"\x00" + uvar(r.randrange(100)) + b"\x07\x14\x28\x00\x00"
        if t == 0:  # Payload Length 65,536 / 65,537 (ASSET_CHUNK 의 data 로 채움)
            head = uvar(1) + b"c" + struct.pack("<BHHI", 0, 0, 1, 10) + bytes(32)
            return frame(7, head + self.rbytes(65536 + k - len(head)))
        if t == 1:  # 프레임당 이벤트 1,024 / 1,025
            n = 1024 + k
            evs = cp + b"".join(bytes([0x01, 3]) + uvar(r.randrange(100)) + uvar(r.randrange(64)) * 2 for _ in range(n - 1))
            return frame(1, evs, count=n, flags=4)
        if t == 2:  # 이벤트 payload 1,024 / 1,025 (아는 이벤트 뒤 남는 바이트, 모르는 이벤트)
            code = r.choice([0x01, 0x80, 0x50])
            body = b"\x00" + self.rbytes(1024 + k - 1)
            ev = bytes([code]) + uvar(len(body)) + body
            return frame(1, cp + ev if code != 0x50 else ev, count=2 if code != 0x50 else 1, flags=4)
        if t == 3:  # CONTROL body 8,192 / 8,193 (subtype 제외)
            sub = r.choice([0x80, 5, 0x0D])
            body = bytes([sub]) + (b"\x01" if sub == 5 else b"") + self.rbytes(8192 + k - (1 if sub == 5 else 0))
            return frame(3, body)
        if t == 4:  # json 2,048 / 2,049 (CHANGE_ORDER params, CAPTCHA_ANSWER answer, CAPTCHA_CHALLENGE meta)
            js = b'{"a":"' + bytes(r.choice(b"abcxyz019") for _ in range(2048 + k - 8)) + b'"}'
            which = r.randrange(3)
            if which == 0:
                body = b"\x03\x01\x01\x00\x00\x00" + uvar(len(js)) + js
            elif which == 1:
                body = b"\x08\x01c\x00" + uvar(len(js)) + js
            else:
                body = b"\x0A\x01c\x01" + struct.pack("<I", 3) + b"\x01\x00\x00\x00" + uvar(len(js)) + js
            return frame(3, body)
        if t == 5:  # ERROR message 256 / 257B
            msg = bytes(r.choice(b"abc ") for _ in range(256 + k))
            return frame(3, b"\x06" + struct.pack("<H", r.randrange(1, 23)) + b"\x01" + uvar(len(msg)) + msg)
        if t == 6:  # FEATURE_SCHEMA model_id 64/65, model_version 32/33, 특징 이름 64/65, 특징 64/65개, 채널 8/9개
            which = r.randrange(5)
            mid = b"m" * (64 + k if which == 0 else 3)
            mver = b"v" * (32 + k if which == 1 else 3)
            names = [b"f" * (64 + k if which == 2 else 2)] + [b"g"] * ((64 + k if which == 3 else 3) - 1)
            nch = 8 + k if which == 4 else 2
            body = (b"\x07\x01" + uvar(len(mid)) + mid + uvar(len(mver)) + mver + b"\x10" + uvar(len(names))
                    + b"".join(uvar(len(n)) + n for n in names) + uvar(nch) + b"\x01a\x01u" * nch)
            return frame(3, body)
        if t == 7:  # WELCOME 사전 항목 64/65개, 항목 64/65B
            which = r.randrange(2)
            items = [b"t" * (64 + k if which == 1 else 4)] + [b"x"] * ((64 + k if which == 0 else 3) - 1)
            head = (b"\x02" + bytes(16) + struct.pack("<Q", 1) + b"\x00\x00" + b"\x32\x98\x75\xE8\x07\x90\x4E\x03"
                    + b"\xA0\x06\x90\x4E\x80\x80\x04\x80\x08\x40")
            return frame(3, head + b"\x01\x01" + uvar(len(items)) + b"".join(uvar(len(i)) + i for i in items))
        if t == 8:  # INFERENCE_RESULT 확장 features 64/65, series 채널 8/9, 점 128/129
            res = struct.pack("<I", 1) + b"\x00\x0A\x05" + struct.pack("<f", 0.5) + b"\x01\x02"
            which = r.randrange(3)
            if which == 0:
                n = 64 + k
                blk = uvar(n) + b"".join(uvar(i) + struct.pack("<f", r.uniform(-9, 9)) for i in range(n))
                tag = 4
            else:
                nch, npt = (8 + k, 2) if which == 1 else (1, 128 + k)
                blk = bytes([nch]) + struct.pack("<H", npt) + b"".join(
                    b"\x01" + struct.pack("<ff", 1.0, 0.0) + self.rbytes(2 * npt) for _ in range(nch))
                tag = 5
            return frame(4, res + b"\x01" + bytes([tag]) + uvar(len(blk)) + blk)
        if t == 9:  # 헤더 Timestamp 2^53-1 / 2^53
            return frame(1, b"", ts=2**53 - 1 + k)
        if t == 10:  # HELLO t0_unix_us(u64) 2^53-1 / 2^53
            body = (b"\x01\x03\x00\x01\x01\x00\x01a\x01k\x00" + struct.pack("<Q", 2**53 - 1 + k)
                    + b"\x80\x0F\xB8\x08\xE8\x07\x01\x00\x01\x78\x00\x00")
            return frame(3, body)
        if t == 11:  # varint 5번째 바이트 0x0F / 0x10 (dt, str 길이, ACK decoded_events)
            v5 = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x0F + k])
            which = r.randrange(3)
            if which == 0:
                return frame(1, bytes([0x50, 12]) + v5 + b"\x00\x07\x14\x28\x00\x00\x00", count=1, flags=4)
            if which == 1:
                return frame(2, struct.pack("<I", r.randrange(2**32)) + v5)
            return frame(3, b"\x0B" + v5 + b"\x00\x00")
        if t == 12:  # ai_score 1.0 과 그 바로 위, 0 과 -0, 그 바로 아래, NaN, 무한대
            bits = r.choice([0x3F800000, 0x3F800001, 0x00000000, 0x80000000, 0x80000001, 0x7FC00000, 0x7F800000,
                             0x00000001, 0x3F7FFFFF])
            return frame(4, struct.pack("<I", 1) + b"\x00\x0A\x05" + struct.pack("<I", bits))
        if t == 13:  # f32 NaN, 무한대, 가장 큰 유한수(MODEL_INPUT, 확장 features)
            bits = r.choice([0x7F7FFFFF, 0x7F800000, 0xFF800000, 0x7FC00000, 0xFFFFFFFF, 0x00000001, 0x80000000])
            if r.random() < 0.5:
                return frame(5, struct.pack("<IIIBBHH", 1, 1, 2, 1, 0, 1, 1) + struct.pack("<I", bits))
            res = struct.pack("<I", 1) + b"\x00\x0A\x05" + struct.pack("<f", 0.5) + b"\x01\x02"
            blk = b"\x01\x01" + struct.pack("<I", bits)
            return frame(4, res + b"\x01\x04" + uvar(len(blk)) + blk)
        if t == 14:  # MODEL_INPUT 데이터 65,516B 와 그보다 4B 큰 것
            cols = 16379 + k
            data = b"".join(struct.pack("<f", r.uniform(-1, 1)) for _ in range(cols))
            return frame(5, struct.pack("<IIIBBHH", 1, 1, 2, 1, 0, 1, cols) + data)
        if t == 15:  # Event Count 1,024 이지만 이벤트가 하나 모자람 / 정확함
            n = 1024
            evs = cp + b"".join(b"\x01\x03\x00\x02\x02" for _ in range(n - 2 + (1 - k)))
            return frame(1, evs, count=n, flags=4)
        if t == 16:  # 예약 플래그 비트 4(TRUNCATED, 허용) / 5(E_FLAGS)
            return frame(1, b"", flags=1 << (4 + k))
        if t == 17:  # Message Type 7 / 8
            return frame(7 + k, uvar(1) + b"c" + struct.pack("<BHHI", 0, 0, 1, 1) + bytes(32) + b"\x00")
        if t == 18:  # seq 와 window_id 의 u32 최대
            return frame(6, b"\x02\x00" + struct.pack("<I", 0xFFFFFFFF), seq=0xFFFFFFFF)
        if t == 19:  # Payload Length 는 65,536 / 65,537 이지만 실제 바이트는 그보다 적음(검사 순서 7과 8)
            return frame(1, self.rbytes(r.randrange(0, 30)), plen=65536 + k)
        if t == 20:  # proto_minor 2 / 1 (HELLO)
            body = (bytes([1, 2 - k]) + b"\x00\x01\x01\x00\x01a\x01k\x00" + struct.pack("<Q", 5)
                    + b"\x80\x0F\xB8\x08\xE8\x07\x01\x00\x01\x78\x00\x00")
            return frame(3, body)
        if t == 21:  # 이벤트 dt 가 length 를 꼭 채움 / 넘음
            ev = bytes([0x80, 2 - k]) + b"\x81\x01"
            return frame(1, cp + ev, count=2, flags=4)
        if t == 22:  # ASSET_CHUNK challenge_id 의 UTF-8 경계(4바이트 글자를 끝에서 자름)
            cid = "가나😀".encode()[: (len("가나😀".encode()) - k)]
            return frame(7, uvar(len(cid)) + cid + struct.pack("<BHHI", 0, 0, 1, 1) + bytes(32) + b"\x01")
        if t == 24:  # 헤더 Timestamp 는 2^53-1 이하지만 이벤트 dt 를 더한 시각이 2^53 을 넘음 / 넘지 않음
            ts = 2**53 - 1 - (0 if over else 10)
            dts = [r.randrange(1, 4) for _ in range(r.randrange(1, 4))]
            evs = bytes([0x50, 8]) + uvar(dts[0] << 1) + b"\x00\x07\x00\x14\x28\x00\x00"
            evs += b"".join(b"\x01\x03" + uvar(d << 1) + b"\x00\x00" for d in dts[1:])
            return frame(1, evs, count=len(dts), flags=4, ts=ts)
        if t == 25:  # WELCOME 사전 종류 코드가 겹치거나, 모르는 종류(숫자 이름)가 아는 종류 뒤에 옴
            kinds = r.choice([[1, 9], [9, 1], [1, 1], [2, 1, 2], [1, 200]])
            head = (b"\x02" + bytes(16) + struct.pack("<Q", 1) + b"\x00\x00" + b"\x32\x98\x75\xE8\x07\x90\x4E\x03"
                    + b"\xA0\x06\x90\x4E\x80\x80\x04\x80\x08\x40")
            return frame(3, head + bytes([len(kinds)]) + b"".join(bytes([c]) + b"\x01\x01" + bytes([0x61 + c % 26])
                                                                  for c in kinds))
        if t == 26:  # json 수의 범위와 정밀도(2^53 밖 정수, double 밖, 실수 표기, -0)
            num = r.choice([b"9007199254740993", b"-9007199254740993", b"123456789012345678901234567890", b"1e400",
                            b"-1e400", b"1e-400", b"5e-324", b"1.0", b"1E2", b"-0", b"0.1", b"9007199254740991"])
            js = b'{"z":' + num + b"}"
            return frame(3, b"\x03\x01\x01\x00\x00\x00" + uvar(len(js)) + js)
        # 23: 크기 상한 경계의 정상 프레임을 Python 인코더로 만들어 뒤에 바이트를 k 개 덧붙임(남는 바이트)
        f = {"header": {"msg_type": "STATE", "flags": [], "seq": 1, "timestamp_us": 1},
             "state": {"state": r.randrange(1, 8), "reason": r.randrange(12), "window_id": r.randrange(2**32)}}
        return encode_frame(f) + b"\x00" * k

    def make(self, cat: str) -> bytes:
        return getattr(self, cat)()


CATEGORIES = ("mutate", "random", "header_ok", "boundary")
SHARE = {"mutate": 0.40, "random": 0.18, "header_ok": 0.28, "boundary": 0.14}


# ---------- 줄이기 ----------

def reduce(buf: bytes, sig: str, py: Worker, ts: Worker, budget: int = 1500) -> bytes:
    """같은 signature 가 나오는 가장 짧은 입력. 헤더 뒤 바이트를 덩어리째 지우고, 지울 때마다 Payload Length 도 맞춰 봄"""
    calls = 0

    def keeps(b: bytes) -> bool:
        nonlocal calls
        calls += 1
        return any(f"{k}|{s}" == sig for k, s in classify(b, py.call(b.hex()), ts.call(b.hex())))

    plen_ok = len(buf) >= 24 and struct.unpack_from("<I", buf, 20)[0] == len(buf) - 24
    cur = buf
    chunk = max(1, (len(cur) - 24) // 2)
    while chunk >= 1 and calls < budget:
        i = 24
        progressed = False
        while i < len(cur) and calls < budget:
            cand = cur[:i] + cur[i + chunk:]
            tries = [fix_plen(cand), cand] if plen_ok else [cand, fix_plen(cand)]
            for c in tries:
                if keeps(c):
                    cur = c
                    progressed = True
                    break
            else:
                i += chunk
        if not progressed:
            chunk //= 2
    return cur


# ---------- 실행 ----------

def known_pending() -> set[str]:
    if not FINDINGS.exists():
        return set()
    data = json.loads(FINDINGS.read_text(encoding="utf-8"))
    return {sig for f in data.get("findings", []) if f.get("status") in ("규격 결정 필요", "규격이 허용")
            for sig in f.get("signatures", [])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261109)
    ap.add_argument("--total", type=int, default=1000)
    ap.add_argument("--report", help="결과 JSON 을 쓸 파일")
    ap.add_argument("--reduce", type=int, default=0, help="묶음마다 최소 재현을 만들 묶음 수(0이면 줄이지 않음)")
    a = ap.parse_args(argv)

    gen = Gen(a.seed)
    counts = {c: max(1, round(a.total * SHARE[c])) for c in CATEGORIES}
    counts["mutate"] += a.total - sum(counts.values())
    plan = [c for c in CATEGORIES for _ in range(counts[c])]
    gen.r.shuffle(plan)

    py, ts = workers()
    pending = known_pending()
    t0 = time.time()
    outcome: dict[str, Counter] = {c: Counter() for c in CATEGORIES}
    groups: dict[str, dict] = {}
    try:
        for n, cat in enumerate(plan):
            buf = gen.make(cat)
            h = buf.hex()
            pr, tr = py.call(h), ts.call(h)
            if pr.get("ok") and tr.get("ok"):
                outcome[cat]["둘 다 성공"] += 1
            elif not pr.get("ok") and not tr.get("ok"):
                outcome[cat]["둘 다 실패"] += 1
            else:
                outcome[cat]["한쪽만 성공"] += 1
            for kind, sig in classify(buf, pr, tr):
                full = f"{kind}|{sig}"
                outcome[cat][kind] += 1
                g = groups.setdefault(full, {"kind": kind, "signature": full, "count": 0, "categories": Counter(),
                                             "example": h.upper(), "py": pr, "ts": tr})
                g["count"] += 1
                g["categories"][cat] += 1
                if len(h) < len(g["example"]):
                    g.update(example=h.upper(), py=pr, ts=tr)
        reduced = 0
        for g in sorted(groups.values(), key=lambda g: (g["kind"] in BENIGN, -g["count"])):
            if reduced >= a.reduce or len(g["example"]) > 8000:
                continue
            small = reduce(bytes.fromhex(g["example"]), g["signature"], py, ts)
            g["minimal"] = small.hex(" ").upper()
            g["minimal_py"], g["minimal_ts"] = py.call(small.hex()), ts.call(small.hex())
            reduced += 1
    finally:
        py.close()
        ts.close()

    failing = [g for g in groups.values() if g["kind"] not in BENIGN and g["signature"] not in pending]
    summary = {
        "seed": a.seed, "total": len(plan), "seconds": round(time.time() - t0, 1),
        "categories": {c: {"cases": counts[c], **outcome[c]} for c in CATEGORIES},
        "groups": sorted(({**g, "categories": dict(g["categories"])} for g in groups.values()),
                         key=lambda g: (g["kind"] in BENIGN, g["signature"])),
    }
    if a.report:
        Path(a.report).write_text(json.dumps(summary, indent=1), encoding="utf-8")  # 짝 없는 서로게이트가 디코드 값에 나올 수 있어 ASCII 로 씀
    print(f"총 {len(plan)}건, {summary['seconds']}초, 시드 {a.seed}")
    for c in CATEGORIES:
        print(f"  {c}: " + ", ".join(f"{k} {v}" for k, v in summary["categories"][c].items()))
    for g in summary["groups"]:
        tag = "허용" if g["kind"] in BENIGN else "기록됨" if g["signature"] in pending else "실패"
        print(f"  [{tag}] {g['signature']} x{g['count']}")
    print(f"버그와 불일치 {len(failing)}묶음")
    return 1 if failing else 0


if __name__ == "__main__":
    sys.exit(main())
