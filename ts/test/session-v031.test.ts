// v0.3.1 Protocol Client 변경. 명세 v0.3.1 에서 바뀐 점 A6, A10, A13, A14
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AvpError, buildFrame, decodeFrame, encodeFrame, MSG, type Obj } from "../src/codec.js";
import { createActveri } from "../src/sdk.js";
import { Session, type Clock, type Transport } from "../src/session.js";
import type { WebSocketLike } from "../src/transport-ws.js";

const DICT = { targets: ["", "search_box", "result_list", "cart_button"], routes: ["", "/shop", "/shop/cart"] };
const HELLO = {
  proto_minor: 3, caps: 0, client_kind: "electron_lab", mission_kind: "custom_mission", run_flags: 1, sdk_version: "t",
  client_key: "pk", mission_id: "m1", t0_unix_us: 1, viewport_width: 800, viewport_height: 600, dpr_milli: 1000,
  input_caps: 0, max_touch_points: 0, browser_family: 1, browser_major: 142, sampling_policy: 0, env_flags: 12,
};
const TOKEN = "3f9c2a7e5b0d4c81a6e2f0b9d7c35a14";

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
  events(): Obj[] { return this.decoded().filter((f) => f.header.msg_type === "DATA").flatMap((f) => f.events); }
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
function welcome(over: Obj = {}) {
  return encodeFrame({ header: hdr("CONTROL", 1), control: {
    subtype: "WELCOME", session_id: "019a6a3c5e107c4b8f213d9e0b7a4c12", server_open_unix_us: 0, caps: 0, server_flags: 5, flush_ms: 50,
    keepalive_ms: 15000, infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 800, captcha_sustain_ms: 10000,
    max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: DICT, block_threshold_milli: 900, captcha_trigger: "protected_action",
    ...over,
  } });
}
const state = (seq: number, st: Obj) => encodeFrame({ header: hdr("STATE", seq), state: { window_id: 3, ...st } });

function open(over: Obj = {}) {
  const tr = new FakeTransport();
  const clock = new FakeClock();
  const s = new Session({ transport: tr, clock, hello: HELLO });
  s.start();
  tr.deliver(welcome(over));
  return { tr, clock, s };
}

describe("A6 판단 결과는 보호 행동의 event_seq 로 짝지음", () => {
  it("protectedAction 은 보낸 PROTECTED_ACTION 의 event_seq 와 같은 action_allowed STATE 가 와야 허용되고 토큰을 넘김", async () => {
    const { tr, s } = open();
    const verdict = s.protectedAction("purchase", 3);
    const ev = tr.events().find((e) => e.event_type === "PROTECTED_ACTION")!;
    expect(ev).toMatchObject({ action_kind: "purchase", target: 3 });
    let settled = false;
    void verdict.then(() => { settled = true; });
    // 번호가 다른 허용과 번호 없는 허용은 이 행동의 결과가 아님
    tr.deliver(state(2, { state: "SCORING", reason: "action_allowed", action_event_seq: ev.event_seq + 7, action_token: TOKEN }));
    tr.deliver(state(3, { state: "SCORING", reason: "action_allowed" }));
    await Promise.resolve();
    expect(settled).toBe(false);
    tr.deliver(state(4, { state: "CAPTCHA_PASSED", reason: "action_allowed", action_event_seq: ev.event_seq, action_token: TOKEN }));
    await expect(verdict).resolves.toEqual({ allowed: true, eventSeq: ev.event_seq, state: "CAPTCHA_PASSED", reason: "action_allowed", token: TOKEN });
  });

  it("같은 번호의 BLOCKED 나 보류(captcha_server_error)는 허용이 아님", async () => {
    const { tr, s } = open();
    const first = s.protectedAction("purchase");
    const second = s.protectedAction("transfer");
    const [a, b] = tr.events().filter((e) => e.event_type === "PROTECTED_ACTION").map((e) => e.event_seq);
    tr.deliver(state(2, { state: "SCORING", reason: "captcha_server_error", action_event_seq: a }));
    tr.deliver(state(3, { state: "BLOCKED", reason: "block_above_threshold", action_event_seq: b }));
    await expect(first).resolves.toMatchObject({ allowed: false, reason: "captcha_server_error", eventSeq: a });
    await expect(second).resolves.toMatchObject({ allowed: false, state: "BLOCKED", eventSeq: b });
  });

  it("결과 없이 세션이 끝나면 허용하지 않음", async () => {
    const { tr, s } = open();
    const verdict = s.protectedAction("submit");
    void tr;
    void s.finish();
    tr.deliver(state(2, { state: "ENDED", reason: "finish" }));
    await expect(verdict).resolves.toMatchObject({ allowed: false, reason: "finish" });
  });
});

describe("A13 FINISH 뒤 ENDED 가 끝내 안 오면", () => {
  it("서버 프레임이 계속 와도 ttl_ms + 20초 안에 ENDED 가 없으면 timeout 으로 끝남", async () => {
    const { tr, clock, s } = open();
    const p = s.finish();
    tr.deliver(state(2, { state: "SCORING", reason: "none" }));
    // 기본 ttl 60초(받은 챌린지가 없을 때) + 20초
    for (let i = 0; i < 1599; i++) clock.tick(50);
    expect(s.state).toBe("finishing");
    clock.tick(50);
    await expect(p).resolves.toMatchObject({ reason: "timeout" });
  });
});

describe("A14 WELCOME 값은 규격 한도로 자름", () => {
  it("한도 밖 값은 가까운 한도로 바꿔 씀", () => {
    const { s } = open({ flush_ms: 0, keepalive_ms: 0, max_payload_bytes: 1_000_000, max_events_per_frame: 5000, max_unacked_frames: 100000 });
    expect(s.config).toEqual({ flush_ms: 10, keepalive_ms: 100, max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64 });
    const big = open({ flush_ms: 999999, keepalive_ms: 999999, max_payload_bytes: 10, max_events_per_frame: 0, max_unacked_frames: 0 }).s;
    expect(big.config).toEqual({ flush_ms: 1000, keepalive_ms: 60000, max_payload_bytes: 4096, max_events_per_frame: 2, max_unacked_frames: 1 });
  });

  it("buildFrame 은 DATA 이벤트 1,024개 초과와 DATA 가 아닌 Event Count 를 거절", () => {
    const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as AvpError).code; } return undefined; };
    expect(code(() => buildFrame(MSG.DATA, 0, 1025, 1, 0, new Uint8Array()))).toBe("E_ENCODE");
    expect(code(() => buildFrame(MSG.STATE, 0, 1, 1, 0, new Uint8Array(6)))).toBe("E_ENCODE");
    expect(code(() => buildFrame(MSG.DATA, 0, 1024, 1, 0, new Uint8Array()))).toBeUndefined();
  });

  it("STATE 토큰 묶음은 event_seq 묶음 없이 쓸 수 없음", () => {
    const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as AvpError).code; } return undefined; };
    expect(code(() => encodeFrame({ header: hdr("STATE", 1), state: { state: "SCORING", reason: "action_allowed", window_id: 1, action_token: TOKEN } }))).toBe("E_ENCODE");
  });
});

describe("A10 SDK 기본 run_flags", () => {
  it("runFlags 를 주지 않으면 HELLO run_flags 비트0(captcha_enabled)이 1", () => {
    const sent: Uint8Array[] = [];
    class FakeWs implements WebSocketLike {
      binaryType = "";
      readyState = 1;
      onopen = null;
      onmessage = null;
      onclose = null;
      send(b: Uint8Array) { sent.push(b); }
      close() {}
    }
    const a = createActveri({ clientKey: "pk", endpoint: "ws://127.0.0.1:1/avp/1/ws", missionId: "m", WebSocketImpl: FakeWs, clock: new FakeClock() });
    expect(decodeFrame(sent[0]!).control.run_flags & 1).toBe(1);
    a.stop();
  });
});

describe("A13 FINISH 때 열려 있던 챌린지", () => {
  it("FINISH 전에 받은 챌린지가 열려 있으면 FINISH 뒤에도 챌린지 화면 DATA 를 보냄", () => {
    const { tr, clock, s } = open();
    tr.deliver(encodeFrame({ header: hdr("CONTROL", 2), control: {
      subtype: "CAPTCHA_CHALLENGE", challenge_id: "ch_1", challenge_no: 1, window_id: 4, reason: "action_above_threshold", ttl_ms: 60000,
      asset_count: 0, asset_total_bytes: 0, meta: { kind: "guide_sol", prompt_code: "bring_sol_home", seed: 7, assets: [] },
    } }, DICT));
    void s.finish();
    const n = tr.events().length;
    s.captchaView("shown", { x: 0, y: 0, w: 832, h: 420 }, clock.now());
    clock.tick(50);
    expect(tr.events().slice(n).map((e) => e.event_type)).toContain("CAPTCHA_VIEW");
  });
});

describe("A17 문제 종류마다 답 허용 키", () => {
  it("guide_sol 답은 reached, elapsed_ms, trajectory 만 남김", () => {
    const { tr, s } = open();
    tr.deliver(encodeFrame({ header: hdr("CONTROL", 2), control: {
      subtype: "CAPTCHA_CHALLENGE", challenge_id: "ch_1", challenge_no: 1, window_id: 4, reason: "action_above_threshold", ttl_ms: 60000,
      asset_count: 0, asset_total_bytes: 0, meta: { kind: "guide_sol", prompt_code: "bring_sol_home", seed: 7, assets: [] },
    } }, DICT));
    s.answerCaptcha({ reached: true, elapsed_ms: 10, order: ["a"], typed: "hello", human: { score: 1 } });
    const ans = tr.decoded().map((f) => f.control).filter((c) => c?.subtype === "CAPTCHA_ANSWER")[0];
    expect(ans.answer).toEqual({ reached: true, elapsed_ms: 10 });
  });

  it("표에 없는 문제 종류면 종류별 키를 모두 버리고 elapsed_ms, trajectory 만 남김", () => {
    const { tr, s } = open();
    tr.deliver(encodeFrame({ header: hdr("CONTROL", 2), control: {
      subtype: "CAPTCHA_CHALLENGE", challenge_id: "ch_1", challenge_no: 1, window_id: 4, reason: "action_above_threshold", ttl_ms: 60000,
      asset_count: 0, asset_total_bytes: 0, meta: { kind: "new_kind", prompt_code: "p", seed: 7, assets: [] },
    } }, DICT));
    s.answerCaptcha({ reached: true, elapsed_ms: 10, trajectory: { v: 1, n: 3 }, typed: "hello" });
    const ans = tr.decoded().map((f) => f.control).filter((c) => c?.subtype === "CAPTCHA_ANSWER")[0];
    expect(ans.answer).toEqual({ elapsed_ms: 10, trajectory: { v: 1, n: 3 } });
  });
});

// A19: TV67~TV72 의 session 기대값은 서버 규칙. 같은 상황에서 클라이언트가 지킬 쪽을 Session 으로 재생하고, 나머지는 벡터에 적은 가짜 서버 시험이 맡음
describe("A19 세션 규칙 벡터 TV67~TV72", () => {
  const v31 = JSON.parse(readFileSync(fileURLToPath(new URL("../../test-vectors/avp1-v0.3.1.json", import.meta.url)), "utf8"));
  const sessionVectors: Obj[] = v31.vectors.filter((v: Obj) => v.session);
  const answers = (tr: FakeTransport) => tr.decoded().map((f) => f.control).filter((c) => c?.subtype === "CAPTCHA_ANSWER");
  const challengeFrame = (seq: number, id: string, ttl = 60000) => encodeFrame({ header: hdr("CONTROL", seq), control: {
    subtype: "CAPTCHA_CHALLENGE", challenge_id: id, challenge_no: 1, window_id: 4, reason: "action_above_threshold", ttl_ms: ttl,
    asset_count: 0, asset_total_bytes: 0, meta: { kind: "guide_sol", prompt_code: "bring_sol_home", seed: 7, assets: [] },
  } }, DICT);

  // 키는 session.expect 와 상황 키. 서버가 할 일과 짝을 이루는 클라이언트 쪽 규칙
  const replays: Record<string, (v: Obj) => Promise<void> | void> = {
    // 서버가 챌린지 결과를 기다리는 동안 클라이언트도 CAPTCHA_RESULT 를 허용으로 보지 않고 자기 번호의 결과만 기다림
    "challenge_open:wait_for_challenge_result": async (v) => {
      const act = v.expected.events.find((e: Obj) => e.event_type === "PROTECTED_ACTION");
      const { tr, s } = open();
      tr.deliver(challengeFrame(2, "ch_6b1f0c9e2d4a47f3b8e5a1c07d92e64f"));
      const verdict = s.protectedAction(act.action_kind, act.target);
      const ev = tr.events().find((e) => e.event_type === "PROTECTED_ACTION")!;
      expect(ev).toMatchObject({ action_kind: act.action_kind, target: act.target });
      let settled = false;
      void verdict.then(() => { settled = true; });
      tr.deliver(encodeFrame({ header: hdr("CONTROL", 3), control: { subtype: "CAPTCHA_RESULT", challenge_id: "ch_6b1f0c9e2d4a47f3b8e5a1c07d92e64f", result: "pass", next_state: "CAPTCHA_PASSED" } }, DICT));
      tr.deliver(state(4, { state: "CAPTCHA_PASSED", reason: "none" }));
      await Promise.resolve();
      expect(settled).toBe(false);
      tr.deliver(state(5, { state: "CAPTCHA_PASSED", reason: "action_allowed", action_event_seq: ev.event_seq, action_token: TOKEN }));
      await expect(verdict).resolves.toMatchObject({ allowed: true, eventSeq: ev.event_seq });
    },
    // 서버가 닫힌 챌린지의 답을 무시하므로 클라이언트는 한 챌린지에 답을 한 번만 보냄
    "challenge_closed:ignore": (v) => {
      const c = v.expected.control;
      const { tr, s } = open();
      tr.deliver(challengeFrame(2, c.challenge_id));
      s.answerCaptcha(c.answer);
      s.answerCaptcha(c.answer);
      tr.deliver(encodeFrame({ header: hdr("CONTROL", 3), control: { subtype: "CAPTCHA_RESULT", challenge_id: c.challenge_id, result: "pass", next_state: "CAPTCHA_PASSED" } }, DICT));
      s.answerCaptcha(c.answer);
      expect(answers(tr)).toEqual([{ subtype: "CAPTCHA_ANSWER", challenge_id: c.challenge_id, status: c.status, answer: c.answer }]);
    },
    // 서버가 만료 뒤 답을 무시하므로 클라이언트는 ttl_ms 가 지나면 timeout 을 보내고 그 뒤 답은 보내지 않음
    "expired:ignore": (v) => {
      const c = v.expected.control;
      const { tr, clock, s } = open();
      tr.deliver(challengeFrame(2, c.challenge_id, 1000));
      for (let i = 0; i < 20; i++) clock.tick(50);
      s.answerCaptcha(c.answer);
      expect(answers(tr).map((a) => [a.challenge_id, a.status])).toEqual([[c.challenge_id, "timeout"]]);
    },
    // 서버가 두 번째 FINISH 를 E_STATE 로 닫으므로 클라이언트는 finish 를 여러 번 불러도 FINISH 를 한 번만 보냄
    "finish_sent:E_STATE": (v) => {
      const c = v.expected.control;
      const { tr, s } = open();
      void s.finish(c.reason);
      void s.finish(c.reason);
      const fins = tr.decoded().map((f) => f.control).filter((x) => x?.subtype === "FINISH");
      expect(fins).toHaveLength(1);
      expect(fins[0]).toMatchObject({ subtype: "FINISH", reason: c.reason });
    },
  };
  const keyOf = (v: Obj) => `${Object.keys(v.session).find((k) => !["expect", "server_e2e", "client_replay"].includes(k))}:${v.session.expect}`;

  it("세션 규칙 벡터는 TV67~TV72 이고 모두 서버 e2e 출처가 있음", () => {
    expect(sessionVectors.map((v) => v.id)).toEqual(["TV67", "TV68", "TV69", "TV70", "TV71", "TV72"]);
    for (const v of sessionVectors) expect(v.session.server_e2e, v.id).toMatch(/^서버 e2e 로 확인: actveri-server\/mock\/tests\/test_\w+\.py::test_\w+$/);
  });

  it("client_replay 를 적은 벡터와 재생 시험이 있는 벡터가 같음", () => {
    const declared = sessionVectors.filter((v) => v.session.client_replay).map(keyOf).sort();
    expect(declared).toEqual(Object.keys(replays).sort());
    for (const v of sessionVectors) if (v.session.client_replay) expect(v.session.client_replay).toBe("ts/test/session-v031.test.ts");
  });

  for (const v of sessionVectors.filter((x) => x.session.client_replay)) {
    it(`${v.id} ${v.name}: ${keyOf(v)} 의 클라이언트 쪽 규칙`, async () => {
      await replays[keyOf(v)]!(v);
    });
  }
});
