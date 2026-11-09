// v0.3 캡챠 중계와 차단. 명세 'CAPTCHA 중계', '판단 시점과 캡챠, 차단', 클라이언트 상태 표
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, sha256, toHex, type Obj } from "../src/codec.js";
import { Session, type CaptchaChallenge, type Clock, type Transport } from "../src/session.js";

const DICT = { targets: ["", "search_box", "result_list", "cart_button"], routes: ["", "/shop", "/shop/cart"] };
const HELLO = {
  proto_minor: 3, caps: 0, client_kind: "electron_lab", mission_kind: "custom_mission", run_flags: 1, sdk_version: "t",
  client_key: "pk", mission_id: "m1", t0_unix_us: 1, viewport_width: 800, viewport_height: 600, dpr_milli: 1000,
  input_caps: 0, max_touch_points: 0, browser_family: 1, browser_major: 142, sampling_policy: 0, env_flags: 12,
};
const v3 = JSON.parse(readFileSync(fileURLToPath(new URL("../../test-vectors/avp1-v0.3.json", import.meta.url)), "utf8"));
const tv = (id: string): Obj => v3.vectors.find((v: Obj) => v.id === id);

class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  closed: number[] = [];
  private msg?: (b: Uint8Array) => void;
  send(b: Uint8Array) { this.sent.push(b); }
  onMessage(cb: (b: Uint8Array) => void) { this.msg = cb; }
  onClose() {}
  close(code = 1000) { this.closed.push(code); }
  deliver(b: Uint8Array) { this.msg!(b); }
  decoded(): Obj[] { return this.sent.map((b) => decodeFrame(b, DICT)); }
  data(): Obj[] { return this.decoded().filter((f) => f.header.msg_type === "DATA"); }
  controls(): Obj[] { return this.decoded().filter((f) => f.control).map((f) => ({ seq: f.header.seq, ...f.control })); }
  answers(): Obj[] { return this.controls().filter((c) => c.subtype === "CAPTCHA_ANSWER"); }
}
class FakeClock implements Clock {
  t = 0;
  fns: (() => void)[] = [];
  now() { return this.t; }
  setInterval(fn: () => void) { this.fns.push(fn); return this.fns.length - 1; }
  clearInterval(h: unknown) { this.fns[h as number] = () => {}; }
  tick(ms: number) { this.t += ms * 1000; this.fns.forEach((f) => f()); }
}

const hdr = (msg_type: string, seq: number, flags: string[] = []) => ({ version: 1, msg_type, flags, event_count: 0, seq, timestamp_us: 0, payload_length: 0 });
const welcome = () => encodeFrame({ header: hdr("CONTROL", 1), control: {
  subtype: "WELCOME", session_id: "019a6a3c5e107c4b8f213d9e0b7a4c12", server_open_unix_us: 0, caps: 0, server_flags: 5, flush_ms: 50,
  keepalive_ms: 15000, infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 800, captcha_sustain_ms: 10000,
  max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: DICT, block_threshold_milli: 900, captcha_trigger: "protected_action",
} });
const ctl = (seq: number, c: Obj) => encodeFrame({ header: hdr("CONTROL", seq), control: c }, DICT);
const state = (seq: number, st: string, reason = "none", window_id = 0) => encodeFrame({ header: hdr("STATE", seq), state: { state: st, reason, window_id } });
const result = (seq: number, final = false) => encodeFrame({ header: hdr("INFERENCE_RESULT", seq, final ? ["FINAL"] : []), result: { window_id: seq, window_start_ms: 0, window_end_ms: 900, event_count: 5, ai_score: 0.95, first_event_seq: 1, last_event_seq: 5 } });

/** 결정적인 가짜 PNG(시그니처 + 채움 바이트) */
function png(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
const hexOf = (b: Uint8Array) => toHex(b).replace(/ /g, "").toLowerCase();
function challenge(seq: number, asset: Uint8Array, over: Obj = {}) {
  return ctl(seq, {
    subtype: "CAPTCHA_CHALLENGE", challenge_id: "ch_1", challenge_no: 1, window_id: 4, reason: "action_above_threshold", ttl_ms: 60000,
    asset_count: 1, asset_total_bytes: asset.length, meta: { kind: "guide_sol", prompt_code: "p", assets: [{ index: 0, name: "a.png", type: "image/png" }] }, ...over,
  });
}
function chunks(firstSeq: number, asset: Uint8Array, size = 32768, over: Obj = {}): Uint8Array[] {
  const n = Math.max(1, Math.ceil(asset.length / size));
  const sha = createHash("sha256").update(asset).digest("hex");
  return Array.from({ length: n }, (_, i) => encodeFrame({ header: hdr("ASSET_CHUNK", firstSeq + i), asset_chunk: {
    challenge_id: "ch_1", asset_index: 0, chunk_index: i, chunk_count: n, asset_size: asset.length, asset_sha256: sha,
    data_hex: hexOf(asset.subarray(i * size, (i + 1) * size)), ...over,
  } }));
}
function open() {
  const tr = new FakeTransport();
  const clock = new FakeClock();
  const s = new Session({ transport: tr, clock, hello: HELLO });
  s.start();
  tr.deliver(welcome());
  const got: CaptchaChallenge[] = [];
  s.onCaptcha((c) => got.push(c));
  return { tr, clock, s, got };
}

describe("sha256", () => {
  it("표준 벡터와 Node crypto 와 같은 값", () => {
    expect(hexOf(sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hexOf(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const big = png(100_003);
    expect(hexOf(sha256(big))).toBe(createHash("sha256").update(big).digest("hex"));
  });
});

describe("캡챠 중계", () => {
  it("CAPTCHA_CHALLENGE 뒤 조각 2개를 모아 크기와 SHA-256 을 확인하고 onCaptcha 로 넘김", () => {
    const { tr, got } = open();
    const asset = png(40_000);
    tr.deliver(challenge(2, asset));
    const [c1, c2] = chunks(3, asset);
    tr.deliver(c1!);
    expect(got).toHaveLength(0);
    tr.deliver(c2!);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ challengeId: "ch_1", challengeNo: 1, windowId: 4, reason: "action_above_threshold", ttlMs: 60000, final: false });
    expect(got[0]!.assets).toHaveLength(1);
    expect(got[0]!.assets[0]).toMatchObject({ index: 0, name: "a.png", type: "image/png" });
    expect(Array.from(got[0]!.assets[0]!.bytes)).toEqual(Array.from(asset));
    expect(tr.answers()).toEqual([]);
  });

  it("SHA-256 이 다르면 화면에 넘기지 않고 CAPTCHA_ANSWER(asset_error)", () => {
    const { tr, got } = open();
    const asset = png(1000);
    tr.deliver(challenge(2, asset));
    tr.deliver(chunks(3, asset, 32768, { asset_sha256: "00".repeat(32) })[0]!);
    expect(got).toEqual([]);
    expect(tr.answers()).toMatchObject([{ challenge_id: "ch_1", status: "asset_error", answer: {} }]);
  });

  it("조각마다 asset_size 가 다르면 asset_error", () => {
    const { tr, got } = open();
    const asset = png(40_000);
    tr.deliver(challenge(2, asset));
    const [c1] = chunks(3, asset);
    tr.deliver(c1!);
    tr.deliver(chunks(3, asset, 32768, { asset_size: 39_999 })[1]!);
    expect(got).toEqual([]);
    expect(tr.answers()).toMatchObject([{ status: "asset_error" }]);
  });

  it("SVG 처럼 받지 않는 형식은 asset_error", () => {
    const { tr, got } = open();
    const asset = png(100);
    tr.deliver(challenge(2, asset, { meta: { kind: "k", prompt_code: "p", assets: [{ index: 0, name: "a.svg", type: "image/svg+xml" }] } }));
    tr.deliver(chunks(3, asset)[0]!);
    expect(got).toEqual([]);
    expect(tr.answers()).toMatchObject([{ status: "asset_error" }]);
  });

  it("모르는 challenge_id 의 조각은 무시(오류도 답도 없음)", () => {
    const { tr, got, s } = open();
    tr.deliver(chunks(2, png(100), 32768, { challenge_id: "ch_zz" })[0]!);
    expect(got).toEqual([]);
    expect(tr.answers()).toEqual([]);
    expect(s.state).toBe("open");
  });

  it("10초 안에 조각이 다 오지 않으면 asset_error", () => {
    const { tr, clock } = open();
    tr.deliver(challenge(2, png(40_000)));
    for (let i = 0; i < 199; i++) clock.tick(50);
    expect(tr.answers()).toEqual([]);
    clock.tick(50);
    expect(tr.answers()).toMatchObject([{ status: "asset_error" }]);
  });

  it("CAPTCHA_VIEW 는 DATA 로, answerCaptcha 는 그 DATA 다음 번호의 CAPTCHA_ANSWER 로 나감. trajectory 는 표의 키만 남김", () => {
    const { tr, clock, s, got } = open();
    const asset = png(100);
    tr.deliver(challenge(2, asset));
    tr.deliver(chunks(3, asset)[0]!);
    s.captchaView("shown", { x: 200, y: 120, w: 480, h: 360 }, clock.now());
    const traj = { ...tv("TV29").expected.control.answer.trajectory, points: [[1, 2, 3]], human: { score: 1 } };
    s.answerCaptcha({ reached: true, elapsed_ms: 4210, trajectory: traj });
    const view = tr.data().at(-1)!;
    expect(view.events[1]).toMatchObject({ event_type: "CAPTCHA_VIEW", phase: "shown", challenge_no: 1, view_x: 200, view_w: 480 });
    const [ans] = tr.answers();
    expect(ans!.seq).toBe(view.header.seq + 1);
    expect(ans).toMatchObject({ challenge_id: "ch_1", status: "answered" });
    expect(ans!.answer).toEqual(tv("TV29").expected.control.answer);
    expect(got).toHaveLength(1);
  });

  it("trajectory 가 1,024B 를 넘으면 빼고 보냄", () => {
    const { tr, s } = open();
    const asset = png(100);
    tr.deliver(challenge(2, asset));
    tr.deliver(chunks(3, asset)[0]!);
    const traj = { v: 1, n: 1, durationMs: 1, pathLengthPx: 1, straightness: 0.1, speedMean: 0.1, speedCV: 0.1, pauseCount: 1, subMovements: 1, jitterPx: 0.1, maxJumpPx: 0.1, dtCV: 0.1, speedProfile: Array.from({ length: 80 }, () => 1234567.891) };
    s.answerCaptcha({ reached: true, trajectory: traj });
    expect(tr.answers()[0]!.answer).toEqual({ reached: true });
  });

  it("ttl_ms 안에 답이 없으면 CAPTCHA_ANSWER(timeout)", () => {
    const { tr, clock } = open();
    const asset = png(100);
    tr.deliver(challenge(2, asset, { ttl_ms: 1000 }));
    tr.deliver(chunks(3, asset)[0]!);
    for (let i = 0; i < 19; i++) clock.tick(50);
    expect(tr.answers()).toEqual([]);
    clock.tick(50);
    expect(tr.answers()).toMatchObject([{ status: "timeout", answer: {} }]);
  });

  it("CAPTCHA_RESULT 와 STATE(CAPTCHA_PASSED, action_allowed) 는 onServerMessage 로 넘기고 세션은 계속", () => {
    const { tr, s } = open();
    const asset = png(100);
    const seen: Obj[] = [];
    s.onServerMessage((f) => seen.push(f));
    tr.deliver(challenge(2, asset));
    tr.deliver(chunks(3, asset)[0]!);
    s.answerCaptcha({ order: ["b"] });
    tr.deliver(ctl(4, { subtype: "CAPTCHA_RESULT", challenge_id: "ch_1", result: "pass", next_state: "CAPTCHA_PASSED" }));
    tr.deliver(state(5, "CAPTCHA_PASSED", "action_allowed", 4));
    expect(seen.map((f) => f.state?.reason).filter(Boolean)).toEqual(["action_allowed"]);
    expect(s.state).toBe("open");
    expect(s.blocked).toBeUndefined();
  });
});

describe("차단", () => {
  it("STATE(BLOCKED) 를 받으면 blocked 를 남기고 FINISH(blocked) 를 보낸 뒤 새 이벤트는 버림", () => {
    const { tr, clock, s } = open();
    tr.deliver(state(2, "BLOCKED", "block_above_threshold", 12));
    expect(s.blocked).toEqual({ reason: "block_above_threshold", windowId: 12 });
    expect(s.state).toBe("finishing");
    expect(tr.controls().find((c) => c.subtype === "FINISH")).toMatchObject({ reason: "blocked" });
    const n = tr.data().length;
    s.push({ t_us: 10, event_type: "POINTER_DOWN", x: 1, y: 1, button: 0, pointer_type: "mouse", trusted: true, target: null });
    clock.tick(50);
    expect(tr.data()).toHaveLength(n);
  });

  it("TV25 바이트(BLOCKED, block_after_captcha_fail)를 그대로 받아도 같음", () => {
    const { tr, s } = open();
    const raw = new Uint8Array(Buffer.from(tv("TV25").hex.replace(/ /g, ""), "hex"));
    new DataView(raw.buffer).setUint32(8, 2, true); // 서버 번호만 이 세션에 맞춤
    tr.deliver(raw);
    expect(s.blocked).toEqual({ reason: "block_after_captcha_fail", windowId: 12 });
  });
});

describe("FINISH 뒤 FINAL 챌린지", () => {
  it("FINISH 뒤 받은 챌린지가 열려 있는 동안만 챌린지 화면 DATA 를 보내고(TV32), 답을 보낸 뒤에는 보내지 않음(TV33)", async () => {
    const { tr, clock, s, got } = open();
    const p = s.finish();
    tr.deliver(result(2, true));
    const asset = png(100);
    tr.deliver(challenge(3, asset));
    tr.deliver(chunks(4, asset)[0]!);
    expect(got[0]!.final).toBe(true);
    const before = tr.data().length;
    s.captchaView("shown", { x: 200, y: 120, w: 480, h: 360 }, clock.now());
    s.push({ t_us: clock.now() + 1, event_type: "POINTER_MOVE", x: 5, y: 5 });
    // 3초가 지나도 FINISH 뒤 서버 프레임을 받았으니 timeout 으로 끝내지 않음
    for (let i = 0; i < 80; i++) clock.tick(50);
    expect(s.state).toBe("finishing");
    const during = tr.data().slice(before);
    expect(during.length).toBeGreaterThan(0);
    expect(during.flatMap((f) => f.events.map((e: Obj) => e.event_type))).toEqual(expect.arrayContaining(["CAPTCHA_VIEW", "POINTER_MOVE"]));
    expect(during.every((f) => !f.header.flags.includes("FINAL"))).toBe(true);
    s.answerCaptcha({ order: ["b"] });
    const after = tr.data().length;
    s.push({ t_us: clock.now(), event_type: "POINTER_DOWN", x: 1, y: 1, button: 0, pointer_type: "mouse", trusted: true, target: null });
    clock.tick(50);
    expect(tr.data()).toHaveLength(after);
    tr.deliver(ctl(5, { subtype: "CAPTCHA_RESULT", challenge_id: "ch_1", result: "fail", next_state: "BLOCKED" }));
    tr.deliver(state(6, "BLOCKED", "block_after_captcha_fail", 2));
    tr.deliver(state(7, "ENDED", "finish"));
    await expect(p).resolves.toMatchObject({ reason: "finish" });
    expect(tr.controls().filter((c) => c.subtype === "FINISH")).toHaveLength(1);
  });

  it("FINISH 뒤 챌린지가 없으면 DATA 를 보내지 않음", () => {
    const { tr, clock, s } = open();
    void s.finish();
    const n = tr.data().length;
    s.captchaView("shown", { x: 0, y: 0, w: 1, h: 1 }, clock.now());
    clock.tick(50);
    expect(tr.data()).toHaveLength(n);
  });
});
