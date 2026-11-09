import base64
import hashlib
import hmac
import json

import pytest

from avp1 import AvpError, issue_token, site_nonce_hash, verify_token

# ts/test/token.test.ts 에도 같은 값이 있다. 두 구현이 같은 문자열을 내야 서버가 SDK 토큰을 검증할 수 있다.
KEY = "avp1-test-signing-key-0123456789abcdef"
SITE_NONCE = "order-7f3a-1794276801"
EXPECTED_SN = "zBKKu1tGOQxrfKUl"
PAYLOAD = {
    "sid": "01JCB7Q4K9T6M2X8N0R5V3W1ZA",
    "site": "pk_demo_shop",
    "jti": "t_8c2f61d0",
    "iat": 1794276801,
    "exp": 1794276921,
    "sn": EXPECTED_SN,
}
EXPECTED_TOKEN = (
    "av1.eyJzaWQiOiIwMUpDQjdRNEs5VDZNMlg4TjBSNVYzVzFaQSIsInNpdGUiOiJwa19kZW1vX3Nob3AiLCJqdGkiOiJ0XzhjMmY2MWQwIiwiaWF0IjoxNzk0Mjc2ODAxLCJleHAiOjE3OTQyNzY5MjEsInNuIjoiekJLS3UxdEdPUXhyZktVbCJ9"
    ".8Xg14JPLrGQGtARFmTCBovtuxuZYkF8eo0M8qmlCKAs"
)

NOW = PAYLOAD["iat"] + 10


def _verify(token, **over):
    kw = {"signing_key": KEY, "site_key": "pk_demo_shop", "now": NOW, "seen_jti": set()}
    kw.update(over)
    return verify_token(token, **kw)


def _code(token, **over):
    with pytest.raises(AvpError) as e:
        _verify(token, **over)
    return e.value.code


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _sign_raw(payload_b64: str, key: str = KEY) -> str:
    sig = hmac.new(key.encode(), ("av1." + payload_b64).encode(), hashlib.sha256).digest()
    return f"av1.{payload_b64}.{_b64(sig)}"


SIG = EXPECTED_TOKEN.split(".")[2]


def test_fixed_key_and_payload_match_ts_token():
    assert issue_token(PAYLOAD, KEY) == EXPECTED_TOKEN


def test_sn_is_first_12_bytes_of_sha256_base64url():
    assert site_nonce_hash(SITE_NONCE) == EXPECTED_SN


def test_bytes_key_gives_same_signature():
    assert issue_token(PAYLOAD, KEY.encode()) == EXPECTED_TOKEN


def test_verifies_ts_token_and_marks_jti():
    seen = set()
    r = _verify(EXPECTED_TOKEN, seen_jti=seen, site_nonce=SITE_NONCE)
    assert r["payload"] == PAYLOAD
    assert r["siteNonceMatch"] is True
    assert PAYLOAD["jti"] in seen


def test_no_site_nonce_gives_null_match():
    assert _verify(EXPECTED_TOKEN)["siteNonceMatch"] is None


def test_other_site_nonce_gives_false():
    assert _verify(EXPECTED_TOKEN, site_nonce="order-other")["siteNonceMatch"] is False


def test_token_without_sn_and_site_nonce_given_is_false():
    no_sn = {k: v for k, v in PAYLOAD.items() if k != "sn"}
    assert _verify(issue_token(no_sn, KEY), site_nonce=SITE_NONCE)["siteNonceMatch"] is False


@pytest.mark.parametrize(
    "token",
    [
        "",
        EXPECTED_TOKEN[4:],
        "av2." + EXPECTED_TOKEN[4:],
        EXPECTED_TOKEN + ".x",
        ".".join(EXPECTED_TOKEN.split(".")[:2]),
        EXPECTED_TOKEN.replace("eyJ", "ey+"),
        "av1.." + SIG,
    ],
    ids=["empty", "no_prefix", "other_prefix", "extra_dot", "no_sig", "non_b64url", "empty_payload"],
)
def test_bad_shape_is_format_error(token):
    assert _code(token) == "E_TOKEN_FORMAT"


def test_signed_non_json_payload_is_format_error():
    assert _code(_sign_raw(_b64(b"not json"))) == "E_TOKEN_FORMAT"


def test_signed_payload_missing_field_is_format_error():
    body = json.dumps({"sid": "s", "site": "pk_demo_shop", "iat": 1, "exp": 2}).encode()
    assert _code(_sign_raw(_b64(body))) == "E_TOKEN_FORMAT"


def test_tampered_payload_is_signature_error():
    forged = _b64(json.dumps({**PAYLOAD, "site": "pk_evil"}, separators=(",", ":")).encode())
    assert _code(f"av1.{forged}.{SIG}", site_key="pk_evil") == "E_TOKEN_SIGNATURE"


def test_other_key_is_signature_error():
    assert _code(issue_token(PAYLOAD, "another-signing-key-0123456789abcdef")) == "E_TOKEN_SIGNATURE"


def test_truncated_signature_is_signature_error():
    assert _code(EXPECTED_TOKEN[:-4]) == "E_TOKEN_SIGNATURE"


def test_passes_until_exp_and_expires_at_exp():
    assert _verify(EXPECTED_TOKEN, now=PAYLOAD["exp"] - 1)["payload"]["jti"] == PAYLOAD["jti"]
    assert _code(EXPECTED_TOKEN, now=PAYLOAD["exp"]) == "E_TOKEN_EXPIRED"


def test_expires_120s_after_issue_even_if_exp_later():
    t = issue_token({**PAYLOAD, "exp": PAYLOAD["iat"] + 3600}, KEY)
    assert _code(t, now=PAYLOAD["iat"] + 120) == "E_TOKEN_EXPIRED"


def test_second_verify_of_same_jti_is_replayed():
    seen = set()
    _verify(EXPECTED_TOKEN, seen_jti=seen)
    assert _code(EXPECTED_TOKEN, seen_jti=seen) == "E_TOKEN_REPLAYED"


def test_other_site_is_site_error_and_does_not_consume_jti():
    seen = set()
    assert _code(EXPECTED_TOKEN, site_key="pk_other", seen_jti=seen) == "E_TOKEN_SITE"
    assert seen == set()


def test_expired_token_does_not_consume_jti():
    seen = set()
    assert _code(EXPECTED_TOKEN, now=PAYLOAD["exp"], seen_jti=seen) == "E_TOKEN_EXPIRED"
    assert seen == set()
