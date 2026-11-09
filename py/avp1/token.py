import base64
import binascii
import hashlib
import hmac
import json
import re

from .codec import AvpError

TOKEN_TTL_SEC = 120
_PREFIX = "av1."
# TS 구현과 같은 입력을 거절해야 두 쪽 판정이 갈리지 않는다. 길이 4k+1 은 어떤 바이트열로도 나올 수 없다.
_B64URL = re.compile(r"[A-Za-z0-9_-]+")


def _b64encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64decode(s: str) -> bytes:
    if not _B64URL.fullmatch(s) or len(s) % 4 == 1:
        raise AvpError("E_TOKEN_FORMAT", "base64url 이 아님")
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except binascii.Error as e:
        raise AvpError("E_TOKEN_FORMAT", "base64url 이 아님") from e


def _key_bytes(key: str | bytes) -> bytes:
    return key.encode("utf-8") if isinstance(key, str) else bytes(key)


def _sign(payload_b64: str, key: str | bytes) -> bytes:
    return hmac.new(_key_bytes(key), (_PREFIX + payload_b64).encode("ascii"), hashlib.sha256).digest()


def site_nonce_hash(site_nonce: str) -> str:
    return _b64encode(hashlib.sha256(site_nonce.encode("utf-8")).digest()[:12])


def issue_token(payload: dict, signing_key: str | bytes) -> str:
    # JSON.stringify 와 같은 바이트를 내야 TS 와 토큰 문자열이 같아진다.
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_b64 = _b64encode(body)
    return f"{_PREFIX}{payload_b64}.{_b64encode(_sign(payload_b64, signing_key))}"


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_payload(p) -> bool:
    return (
        isinstance(p, dict)
        and isinstance(p.get("sid"), str)
        and isinstance(p.get("site"), str)
        and isinstance(p.get("jti"), str)
        and _is_int(p.get("iat"))
        and _is_int(p.get("exp"))
        and ("sn" not in p or isinstance(p["sn"], str))
    )


def verify_token(token, *, signing_key, site_key, now, seen_jti, site_nonce=None) -> dict:
    if not isinstance(token, str) or not token.startswith(_PREFIX):
        raise AvpError("E_TOKEN_FORMAT", "av1. 접두사 없음")
    parts = token[len(_PREFIX):].split(".")
    if len(parts) != 2:
        raise AvpError("E_TOKEN_FORMAT", "구획 수가 다름")
    payload_b64, sig_b64 = parts
    payload_bytes = _b64decode(payload_b64)
    sig = _b64decode(sig_b64)

    # 페이로드를 열어 보기 전에 서명부터 본다. 위조된 JSON 을 해석하지 않기 위해서다.
    if not hmac.compare_digest(sig, _sign(payload_b64, signing_key)):
        raise AvpError("E_TOKEN_SIGNATURE")

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise AvpError("E_TOKEN_FORMAT", "페이로드가 JSON 이 아님") from e
    if not _is_payload(payload):
        raise AvpError("E_TOKEN_FORMAT", "페이로드 필드가 맞지 않음")

    if payload["site"] != site_key:
        raise AvpError("E_TOKEN_SITE")
    if now >= payload["exp"] or now >= payload["iat"] + TOKEN_TTL_SEC:
        raise AvpError("E_TOKEN_EXPIRED")
    if payload["jti"] in seen_jti:
        raise AvpError("E_TOKEN_REPLAYED")
    seen_jti.add(payload["jti"])

    if site_nonce is None:
        match = None
    else:
        match = "sn" in payload and payload["sn"] == site_nonce_hash(site_nonce)
    return {"payload": payload, "siteNonceMatch": match}
