import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AvpError, issueToken, siteNonceHash, verifyToken, type TokenPayload } from "../src/index.js";

// py/tests/test_token.py 에도 같은 값이 있다. 두 구현이 같은 문자열을 내야 서버가 SDK 토큰을 검증할 수 있다.
const KEY = "avp1-test-signing-key-0123456789abcdef";
const SITE_NONCE = "order-7f3a-1794276801";
const EXPECTED_SN = "zBKKu1tGOQxrfKUl";
const PAYLOAD: TokenPayload = {
  sid: "01JCB7Q4K9T6M2X8N0R5V3W1ZA",
  site: "pk_demo_shop",
  jti: "t_8c2f61d0",
  iat: 1794276801,
  exp: 1794276921,
  sn: EXPECTED_SN,
};
const EXPECTED_TOKEN =
  "av1.eyJzaWQiOiIwMUpDQjdRNEs5VDZNMlg4TjBSNVYzVzFaQSIsInNpdGUiOiJwa19kZW1vX3Nob3AiLCJqdGkiOiJ0XzhjMmY2MWQwIiwiaWF0IjoxNzk0Mjc2ODAxLCJleHAiOjE3OTQyNzY5MjEsInNuIjoiekJLS3UxdEdPUXhyZktVbCJ9.8Xg14JPLrGQGtARFmTCBovtuxuZYkF8eo0M8qmlCKAs";

const NOW = PAYLOAD.iat + 10;

function opts(over: Partial<Parameters<typeof verifyToken>[1]> = {}) {
  return { signingKey: KEY, siteKey: "pk_demo_shop", now: NOW, seenJti: new Set<string>(), ...over };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AvpError) return e.code;
    throw e;
  }
  return undefined;
}

function signRaw(payloadB64: string, key = KEY): string {
  const sig = createHmac("sha256", key).update("av1." + payloadB64).digest("base64url");
  return `av1.${payloadB64}.${sig}`;
}

describe("판정 토큰 발급", () => {
  it("고정 키와 페이로드는 Python 과 같은 토큰 문자열을 낸다", () => {
    expect(issueToken(PAYLOAD, KEY)).toBe(EXPECTED_TOKEN);
  });

  it("sn 은 siteNonce SHA-256 앞 12바이트의 base64url 이다", () => {
    expect(siteNonceHash(SITE_NONCE)).toBe(EXPECTED_SN);
  });

  it("Uint8Array 키도 같은 서명을 낸다", () => {
    expect(issueToken(PAYLOAD, new TextEncoder().encode(KEY))).toBe(EXPECTED_TOKEN);
  });
});

describe("판정 토큰 검증", () => {
  it("Python 이 만든 토큰을 검증하고 jti 를 사용 처리한다", () => {
    const seen = new Set<string>();
    const r = verifyToken(EXPECTED_TOKEN, opts({ seenJti: seen, siteNonce: SITE_NONCE }));
    expect(r.payload).toEqual(PAYLOAD);
    expect(r.siteNonceMatch).toBe(true);
    expect(seen.has(PAYLOAD.jti)).toBe(true);
  });

  it("siteNonce 를 주지 않으면 siteNonceMatch 는 null", () => {
    expect(verifyToken(EXPECTED_TOKEN, opts()).siteNonceMatch).toBe(null);
  });

  it("다른 siteNonce 면 siteNonceMatch 는 false", () => {
    expect(verifyToken(EXPECTED_TOKEN, opts({ siteNonce: "order-other" })).siteNonceMatch).toBe(false);
  });

  it("토큰에 sn 이 없는데 siteNonce 를 주면 false", () => {
    const { sn: _sn, ...noSn } = PAYLOAD;
    const t = issueToken(noSn, KEY);
    expect(verifyToken(t, opts({ siteNonce: SITE_NONCE })).siteNonceMatch).toBe(false);
  });

  it.each([
    ["빈 문자열", ""],
    ["접두사 없음", EXPECTED_TOKEN.slice(4)],
    ["다른 접두사", "av2." + EXPECTED_TOKEN.slice(4)],
    ["점이 하나 더", EXPECTED_TOKEN + ".x"],
    ["서명 없음", EXPECTED_TOKEN.split(".").slice(0, 2).join(".")],
    ["base64url 밖의 문자", EXPECTED_TOKEN.replace("eyJ", "ey+")],
    ["빈 페이로드", "av1.." + EXPECTED_TOKEN.split(".")[2]],
  ])("%s 는 E_TOKEN_FORMAT", (_name, token) => {
    expect(codeOf(() => verifyToken(token, opts()))).toBe("E_TOKEN_FORMAT");
  });

  it("서명은 맞지만 페이로드가 JSON 이 아니면 E_TOKEN_FORMAT", () => {
    const t = signRaw(Buffer.from("not json").toString("base64url"));
    expect(codeOf(() => verifyToken(t, opts()))).toBe("E_TOKEN_FORMAT");
  });

  it("서명은 맞지만 필수 필드가 빠지면 E_TOKEN_FORMAT", () => {
    const t = signRaw(Buffer.from(JSON.stringify({ sid: "s", site: "pk_demo_shop", iat: 1, exp: 2 })).toString("base64url"));
    expect(codeOf(() => verifyToken(t, opts()))).toBe("E_TOKEN_FORMAT");
  });

  it("페이로드를 바꾸면 E_TOKEN_SIGNATURE", () => {
    const forged = Buffer.from(JSON.stringify({ ...PAYLOAD, site: "pk_evil" })).toString("base64url");
    const t = `av1.${forged}.${EXPECTED_TOKEN.split(".")[2]}`;
    expect(codeOf(() => verifyToken(t, opts({ siteKey: "pk_evil" })))).toBe("E_TOKEN_SIGNATURE");
  });

  it("다른 키로 서명하면 E_TOKEN_SIGNATURE", () => {
    const t = issueToken(PAYLOAD, "another-signing-key-0123456789abcdef");
    expect(codeOf(() => verifyToken(t, opts()))).toBe("E_TOKEN_SIGNATURE");
  });

  it("잘린 서명은 E_TOKEN_SIGNATURE", () => {
    expect(codeOf(() => verifyToken(EXPECTED_TOKEN.slice(0, -4), opts()))).toBe("E_TOKEN_SIGNATURE");
  });

  it("exp 직전까지는 통과하고 exp 시각부터 E_TOKEN_EXPIRED", () => {
    expect(verifyToken(EXPECTED_TOKEN, opts({ now: PAYLOAD.exp - 1 })).payload.jti).toBe(PAYLOAD.jti);
    expect(codeOf(() => verifyToken(EXPECTED_TOKEN, opts({ now: PAYLOAD.exp })))).toBe("E_TOKEN_EXPIRED");
  });

  it("발급 120초가 지나면 exp 가 더 뒤여도 E_TOKEN_EXPIRED", () => {
    const t = issueToken({ ...PAYLOAD, exp: PAYLOAD.iat + 3600 }, KEY);
    expect(codeOf(() => verifyToken(t, opts({ now: PAYLOAD.iat + 120 })))).toBe("E_TOKEN_EXPIRED");
  });

  it("같은 jti 두 번째 검증은 E_TOKEN_REPLAYED", () => {
    const seen = new Set<string>();
    verifyToken(EXPECTED_TOKEN, opts({ seenJti: seen }));
    expect(codeOf(() => verifyToken(EXPECTED_TOKEN, opts({ seenJti: seen })))).toBe("E_TOKEN_REPLAYED");
  });

  it("다른 사이트 토큰은 E_TOKEN_SITE 이고 jti 를 쓰지 않는다", () => {
    const seen = new Set<string>();
    expect(codeOf(() => verifyToken(EXPECTED_TOKEN, opts({ siteKey: "pk_other", seenJti: seen })))).toBe("E_TOKEN_SITE");
    expect(seen.size).toBe(0);
  });

  it("만료된 토큰은 jti 를 쓰지 않는다", () => {
    const seen = new Set<string>();
    codeOf(() => verifyToken(EXPECTED_TOKEN, opts({ now: PAYLOAD.exp, seenJti: seen })));
    expect(seen.size).toBe(0);
  });
});
