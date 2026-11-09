// v0.3.2 iframe 캡챠의 클라이언트 쪽 규칙. 명세 'CAPTCHA 서버 API (v0.3.2)', 'CAPTCHA iframe 챌린지 (v0.3.2)', B1, B3, B5, B7
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, fromHex, type Obj } from "../src/codec.js";
import { SDK_VERSION } from "../src/sdk.js";
import { Session, type CaptchaChallenge, type Clock, type Transport } from "../src/session.js";

const DICT = { targets: ["", "search_box"], routes: ["", "/shop"] };
const HELLO = {
  proto_minor: 3, caps: 0, client_kind: "browser_sdk", mission_kind: "custom_mission", run_flags: 1, sdk_version: "t",
  client_key: "pk", mission_id: "m1", t0_unix_us: 1, viewport_width: 800, viewport_height: 600, dpr_milli: 1000,
  input_caps: 0, max_touch_points: 0, browser_family: 1, browser_major: 142, sampling_policy: 0, env_flags: 12,
};
const v32 = JSON.parse(readFileSync(fileURLToPath(new URL("../../test-vectors/avp1-v0.3.2.json", import.meta.url)), "utf8"));
const tv = (id: string): Obj => v32.vectors.find((v: Obj) => v.id === id);
const ID = "q3Zt8mVw1xKp4LrN7cYe2HsJ9bFd6GaU";
const FRAME_URL = tv("TV74").expected.control.frame_url as string;
const FRAME_ORIGIN = "https://captcha.example.com";

class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  private msg?: (b: Uint8Array) => void;
  send(b: Uint8Array) { this.sent.push(b); }
  onMessage(cb: (b: Uint8Array) => void) { this.msg = cb; }
  onClose() {}
  close() {}
  deliver(b: Uint8Array) { this.msg!(b); }
  answers(): Obj[] { return this.sent.map((b) => decodeFrame(b, DICT).control).filter((c) => c?.subtype === "CAPTCHA_ANSWER"); }
}
class FakeClock implements Clock {
  t = 0;
  fns: (() => void)[] = [];
  now() { return this.t; }
  setInterval(fn: () => void) { this.fns.push(fn); return this.fns.length - 1; }
  clearInterval(h: unknown) { this.fns[h as number] = () => {}; }
  tick(ms: number) { this.t += ms * 1000; this.fns.forEach((f) => f()); }
}

const hdr = (msg_type: string, seq: number) => ({ version: 1, msg_type, flags: [], event_count: 0, seq, timestamp_us: 0, payload_length: 0 });
const welcome = () => encodeFrame({ header: hdr("CONTROL", 1), control: {
  subtype: "WELCOME", session_id: "019a6a3c5e107c4b8f213d9e0b7a4c12", server_open_unix_us: 0, caps: 0, server_flags: 5, flush_ms: 50,
  keepalive_ms: 15000, infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 800, captcha_sustain_ms: 10000,
  max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: DICT, block_threshold_milli: 900, captcha_trigger: "protected_action",
} });
const challenge = (seq: number, over: Obj = {}) => encodeFrame({ header: hdr("CONTROL", seq), control: {
  subtype: "CAPTCHA_CHALLENGE", challenge_id: ID, challenge_no: 1, window_id: 8, reason: "action_above_threshold", ttl_ms: 60000,
  asset_count: 0, asset_total_bytes: 0, meta: { kind: "guide_sol" }, frame_url: FRAME_URL, ...over,
} }, DICT);
/** 벡터 바이트를 그대로 쓰고 서버 번호만 세션 순서(2)에 맞춤. 헤더에는 CRC 가 없어 다른 바이트는 그대로 */
function vectorFrame(id: string, seq = 2): Uint8Array {
  const b = fromHex(tv(id).hex);
  new DataView(b.buffer, b.byteOffset).setUint32(8, seq, true);
  return b;
}

function open() {
  const tr = new FakeTransport();
  const clock = new FakeClock();
  const s = new Session({ transport: tr, clock, hello: HELLO });
  const got: CaptchaChallenge[] = [];
  s.onCaptcha((c) => got.push(c));
  s.start();
  tr.deliver(welcome());
  return { tr, clock, s, got };
}
/** 열린 iframe 챌린지와, 그 iframe 의 contentWindow 자리에 둘 값 */
function framed() {
  const o = open();
  o.tr.deliver(challenge(2));
  return { ...o, frame: { name: "iframe contentWindow" } };
}
const msg = (frame: unknown, data: Obj, origin = FRAME_ORIGIN) => ({ source: frame, origin, data });

describe("B1, B7 frame_url 을 그대로 onCaptcha 로 넘김", () => {
  it("frame_url 이 있는 챌린지는 에셋을 기다리지 않고 받은 주소 그대로 넘김(쿼리를 고치지 않음)", () => {
    const { tr, got } = open();
    tr.deliver(vectorFrame("TV74"));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ challengeId: ID, frameUrl: FRAME_URL, assets: [], meta: { kind: "guide_sol" } });
    expect(tr.answers()).toEqual([]);
  });

  it("서명이 붙은 1,024B 주소(TV78)도 그대로 넘김", () => {
    const { tr, got } = open();
    tr.deliver(vectorFrame("TV78"));
    expect(got[0]!.frameUrl).toBe(tv("TV78").expected.control.frame_url);
    expect(tr.answers()).toEqual([]);
  });
});

describe("frame_url 규칙: https, 개발에서만 127.0.0.1 과 localhost 의 http", () => {
  const cases: [string, boolean][] = [
    ["https://captcha.example.com/challenges/x/frame", true],
    ["http://127.0.0.1:8100/challenges/x/frame", true],
    ["http://localhost:8100/challenges/x/frame", true],
    ["http://captcha.example.com/challenges/x/frame", false],
    ["http://127.0.0.2/challenges/x/frame", false],
    ["http://localhost.example.com/challenges/x/frame", false],
    ["javascript:alert(1)", false],
    ["data:text/html,<p>x</p>", false],
    ["/challenges/x/frame", false],
    ["", false],
  ];
  for (const [url, ok] of cases) {
    it(`${JSON.stringify(url)} → ${ok ? "연다" : "frame_error"}`, () => {
      const { tr, got } = open();
      tr.deliver(challenge(2, { frame_url: url }));
      if (ok) {
        expect(got.map((c) => c.frameUrl)).toEqual([url]);
        expect(tr.answers()).toEqual([]);
      } else {
        expect(got).toEqual([]);
        expect(tr.answers()).toEqual([{ subtype: "CAPTCHA_ANSWER", challenge_id: ID, status: "frame_error", answer: {} }]);
      }
    });
  }
});

describe("postMessage 는 출처, 보낸 창, 종류, 챌린지 번호가 모두 맞을 때만 받음", () => {
  const ok = { type: "actveri-captcha", challenge_id: ID, status: "success", token: "vT9kq2Xr7LmN4pZs8YdW1cHf6JbG3aEo5uRiQxKtMnV" };

  it("맞는 success 는 토큰과 함께 CAPTCHA_ANSWER(TV75 와 같은 본문)로 보냄", () => {
    const { tr, s, frame } = framed();
    expect(s.captchaMessage(msg(frame, ok), frame)).toBe(true);
    expect(tr.answers()).toEqual([tv("TV75").expected.control]);
  });

  it("fail 은 토큰 없이 보냄(TV76), 함께 온 토큰은 버림", () => {
    const { tr, s, frame } = framed();
    expect(s.captchaMessage(msg(frame, { ...ok, status: "fail" }), frame)).toBe(true);
    expect(tr.answers()).toEqual([tv("TV76").expected.control]);
  });

  const rejects: [string, (frame: Obj) => ReturnType<typeof msg>][] = [
    ["다른 창이 보낸 것", () => msg({ name: "other window" }, ok)],
    ["출처가 다른 것", (f) => msg(f, ok, "https://evil.example.com")],
    ["출처가 http 로 바뀐 것", (f) => msg(f, ok, "http://captcha.example.com")],
    ["type 이 다른 것", (f) => msg(f, { ...ok, type: "captcha" })],
    ["challenge_id 가 다른 것", (f) => msg(f, { ...ok, challenge_id: "x".repeat(32) })],
    ["status 가 success, fail 이 아닌 것", (f) => msg(f, { ...ok, status: "frame_error" })],
    ["data 가 객체가 아닌 것", (f) => msg(f, "actveri-captcha" as unknown as Obj)],
  ];
  for (const [name, make] of rejects) {
    it(`${name} 는 버림`, () => {
      const { tr, s, frame } = framed();
      expect(s.captchaMessage(make(frame), frame)).toBe(false);
      expect(tr.answers()).toEqual([]);
    });
  }

  it("처음 받은 결과 하나만 보내고 나머지는 버림", () => {
    const { tr, s, frame } = framed();
    expect(s.captchaMessage(msg(frame, { ...ok, status: "fail" }), frame)).toBe(true);
    expect(s.captchaMessage(msg(frame, ok), frame)).toBe(false);
    expect(tr.answers().map((a) => a.status)).toEqual(["fail"]);
  });

  it("success 의 토큰이 없거나 128B 를 넘으면 토큰 없이 success 를 보냄(TV87)", () => {
    for (const token of [undefined, "t".repeat(129), 42]) {
      const { tr, s, frame } = framed();
      expect(s.captchaMessage(msg(frame, { ...ok, token }), frame)).toBe(true);
      expect(tr.answers()).toEqual([tv("TV87").expected.control]);
    }
  });

  it("128B 토큰(TV80)은 그대로 보냄", () => {
    const { tr, s, frame } = framed();
    s.captchaMessage(msg(frame, { ...ok, token: "t".repeat(128) }), frame);
    expect(tr.answers()).toEqual([tv("TV80").expected.control]);
  });

  it("에셋 중계 챌린지에는 postMessage 를 받지 않음", () => {
    const { tr, s } = open();
    tr.deliver(vectorFrame("TV86"));
    const frame = {};
    expect(s.captchaMessage(msg(frame, ok), frame)).toBe(false);
    expect(tr.answers()).toEqual([]);
  });
});

describe("B5 iframe 로드 실패는 frame_error", () => {
  it("CAPTCHA_CHALLENGE 뒤 10초 안에 load 가 없으면 frame_error(TV77)", () => {
    const { tr, clock } = framed();
    clock.tick(9950);
    expect(tr.answers()).toEqual([]);
    clock.tick(50);
    expect(tr.answers()).toEqual([tv("TV77").expected.control]);
  });

  it("load 를 알리면 10초가 지나도 frame_error 를 보내지 않고 ttl_ms 뒤 timeout", () => {
    const { tr, clock, s } = framed();
    s.captchaFrameLoaded();
    clock.tick(10_000);
    expect(tr.answers()).toEqual([]);
    clock.tick(50_000);
    expect(tr.answers().map((a) => a.status)).toEqual(["timeout"]);
  });

  it("로드 오류를 알리면 바로 frame_error 를 한 번만 보냄", () => {
    const { tr, clock, s } = framed();
    s.captchaFrameError();
    s.captchaFrameError();
    clock.tick(10_000);
    expect(tr.answers()).toEqual([tv("TV77").expected.control]);
  });
});

describe("B3 answerCaptcha 는 iframe 챌린지에서 status 와 verification_token 만 보냄", () => {
  it("answer 는 늘 {} 이고 trajectory 와 다른 키는 실리지 않음", () => {
    const { tr, s } = framed();
    s.answerCaptcha({ status: "success", verification_token: tv("TV75").expected.control.verification_token, reached: true, trajectory: { v: 1, n: 3 } });
    expect(tr.answers()).toEqual([tv("TV75").expected.control]);
  });

  it("success, fail 이 아닌 status 는 보내지 않고 오류를 던짐", () => {
    const { tr, s } = framed();
    expect(() => s.answerCaptcha({ status: "answered" })).toThrow();
    expect(tr.answers()).toEqual([]);
  });
});

describe("SDK", () => {
  it("HELLO sdk_version 은 v0.3.2 클라이언트를 가리킴", () => {
    expect(SDK_VERSION).toBe("stlab/0.3.2");
  });
});

// TV84~TV86 의 session.client_replay 는 이 파일을 가리킴. 벡터 바이트를 Session 에 넣어 클라이언트가 할 일을 재생함
describe("세션 규칙 벡터 TV84~TV86", () => {
  const sessionVectors: Obj[] = v32.vectors.filter((v: Obj) => v.session?.client_replay);
  const replays: Record<string, (v: Obj) => void> = {
    show_frame: (v) => {
      const { tr, got } = open();
      tr.deliver(vectorFrame(v.id));
      expect(got.map((c) => c.frameUrl)).toEqual([v.expected.control.frame_url]);
      expect(tr.answers()).toEqual([]);
    },
    frame_error: (v) => {
      const { tr, got } = open();
      tr.deliver(vectorFrame(v.id));
      expect(got).toEqual([]);
      expect(tr.answers()).toEqual([{ subtype: "CAPTCHA_ANSWER", challenge_id: v.expected.control.challenge_id, status: "frame_error", answer: {} }]);
    },
    asset_relay: (v) => {
      const { tr, got } = open();
      tr.deliver(vectorFrame(v.id));
      expect(got).toHaveLength(1);
      expect(got[0]!.frameUrl).toBeUndefined();
      expect(got[0]).toMatchObject({ challengeId: v.expected.control.challenge_id, assets: [] });
      expect(tr.answers()).toEqual([]);
    },
  };

  it("client_replay 를 적은 벡터는 TV84~TV86 이고 모두 이 파일을 가리킴", () => {
    expect(sessionVectors.map((v) => v.id)).toEqual(["TV84", "TV85", "TV86"]);
    for (const v of sessionVectors) expect(v.session.client_replay).toBe("ts/test/session-v032.test.ts");
    expect(sessionVectors.map((v) => v.session.expect).sort()).toEqual(Object.keys(replays).sort());
  });

  for (const v of sessionVectors) {
    it(`${v.id} ${v.name}: ${v.session.expect}`, () => replays[v.session.expect]!(v));
  }
});
