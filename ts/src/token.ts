import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AvpError } from "./codec.js";

export type TokenPayload = {
  sid: string;
  site: string;
  jti: string;
  iat: number;
  exp: number;
  sn?: string;
};

export type VerifyOptions = {
  signingKey: string | Uint8Array;
  siteKey: string;
  now: number;
  seenJti: Set<string>;
  siteNonce?: string;
};

const PREFIX = "av1.";
export const TOKEN_TTL_SEC = 120;
// Buffer.from(_, "base64url") 은 잘못된 문자를 조용히 버리므로 먼저 막는다. 길이 4k+1 은 어떤 바이트열로도 나올 수 없다.
const B64URL = /^[A-Za-z0-9_-]+$/;

function b64urlDecode(s: string): Buffer {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new AvpError("E_TOKEN_FORMAT", "base64url 이 아님");
  return Buffer.from(s, "base64url");
}

function sign(payloadB64: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(PREFIX + payloadB64).digest();
}

export function siteNonceHash(siteNonce: string): string {
  return createHash("sha256").update(siteNonce, "utf8").digest().subarray(0, 12).toString("base64url");
}

export function issueToken(payload: TokenPayload, signingKey: string | Uint8Array): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${PREFIX}${payloadB64}.${sign(payloadB64, signingKey).toString("base64url")}`;
}

function isPayload(p: unknown): p is TokenPayload {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.sid === "string" &&
    typeof o.site === "string" &&
    typeof o.jti === "string" &&
    Number.isInteger(o.iat) &&
    Number.isInteger(o.exp) &&
    (o.sn === undefined || typeof o.sn === "string")
  );
}

export function verifyToken(
  token: string,
  opts: VerifyOptions,
): { payload: TokenPayload; siteNonceMatch: boolean | null } {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) throw new AvpError("E_TOKEN_FORMAT", "av1. 접두사 없음");
  const parts = token.slice(PREFIX.length).split(".");
  if (parts.length !== 2) throw new AvpError("E_TOKEN_FORMAT", "구획 수가 다름");
  const [payloadB64, sigB64] = parts as [string, string];
  const payloadBytes = b64urlDecode(payloadB64);
  const sig = b64urlDecode(sigB64);

  // 페이로드를 열어 보기 전에 서명부터 본다. 위조된 JSON 을 해석하지 않기 위해서다.
  const expected = sign(payloadB64, opts.signingKey);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new AvpError("E_TOKEN_SIGNATURE");

  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new AvpError("E_TOKEN_FORMAT", "페이로드가 JSON 이 아님");
  }
  if (!isPayload(payload)) throw new AvpError("E_TOKEN_FORMAT", "페이로드 필드가 맞지 않음");

  if (payload.site !== opts.siteKey) throw new AvpError("E_TOKEN_SITE");
  if (opts.now >= payload.exp || opts.now >= payload.iat + TOKEN_TTL_SEC) throw new AvpError("E_TOKEN_EXPIRED");
  if (opts.seenJti.has(payload.jti)) throw new AvpError("E_TOKEN_REPLAYED");
  opts.seenJti.add(payload.jti);

  const siteNonceMatch =
    opts.siteNonce === undefined ? null : payload.sn !== undefined && payload.sn === siteNonceHash(opts.siteNonce);
  return { payload, siteNonceMatch };
}
