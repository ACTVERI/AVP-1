import { describe, expect, it } from "vitest";
import { crc32, decodeFrame, encodeFrame, type Obj } from "../src/codec.js";
import { Session, type Clock, type TapRecord, type Transport } from "../src/session.js";

const DICT = { targets: ["", "search_box", "result_list"], routes: ["", "/shop", "/shop/cart"] };
const HELLO = {
  proto_minor: 2, caps: 0, client_kind: "electron_lab", mission_kind: "custom_mission", run_flags: 5, sdk_version: "t",
  client_key: "pk", mission_id: "m1", t0_unix_us: 1, viewport_width: 800, viewport_height: 600, dpr_milli: 1000,
  input_caps: 0, max_touch_points: 0, browser_family: 1, browser_major: 142, sampling_policy: 0, env_flags: 12,
};

class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  closed: number[] = [];
  private msg?: (b: Uint8Array) => void;
  private closeCb?: (code: number) => void;
  send(b: Uint8Array) { this.sent.push(b); }
  onMessage(cb: (b: Uint8Array) => void) { this.msg = cb; }
  onClose(cb: (code: number) => void) { this.closeCb = cb; }
  close(code = 1000) { this.closed.push(code); }
  deliver(b: Uint8Array) { this.msg!(b); }
  drop(code = 1006) { this.closeCb!(code); }
  decoded(): Obj[] { return this.sent.map((b) => decodeFrame(b, DICT)); }
  data(): Obj[] { return this.decoded().filter((f) => f.header.msg_type === "DATA"); }
  controls(): Obj[] { return this.decoded().filter((f) => f.control).map((f) => ({ seq: f.header.seq, ...f.control })); }
  acks(): number[] { return this.decoded().filter((f) => f.header.msg_type === "ACK").map((f) => f.header.seq); }
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
const server = {
  welcome: (over: Obj = {}) => encodeFrame({ header: hdr("CONTROL", 1), control: {
    subtype: "WELCOME", session_id: "019a6a3c5e107c4b8f213d9e0b7a4c12", server_open_unix_us: 0, caps: 0, server_flags: 15, flush_ms: 50,
    keepalive_ms: 15000, infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 0, captcha_sustain_ms: 10000,
    max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 4, dict: DICT, ...over,
  } }),
  ack: (seq: number, sent?: Uint8Array) => encodeFrame({ header: hdr("ACK", seq), ...(sent ? { ack: { frame_crc32: crc32(sent).toString(16).toUpperCase().padStart(8, "0"), decoded_events: 1 } } : {}) }),
  control: (seq: number, c: Obj) => encodeFrame({ header: hdr("CONTROL", seq), control: c }, DICT),
  result: (seq: number, final = false) => encodeFrame({ header: hdr("INFERENCE_RESULT", seq, final ? ["FINAL"] : []), result: { window_id: seq, window_start_ms: 0, window_end_ms: 900, event_count: 5, ai_score: 0.25, first_event_seq: 1, last_event_seq: 5 } }),
  state: (seq: number, state: string, reason = "none") => encodeFrame({ header: hdr("STATE", seq), state: { state, reason, window_id: 0 } }),
};
const changeOrder = { subtype: "CHANGE_ORDER", anchor: 1, kind: "price_update", target_av: "result_list", deadline_ms: 8000, require_route: "/shop", params: { item: "p2" } };

function open(over: Obj = {}) {
  const tr = new FakeTransport();
  const clock = new FakeClock();
  const s = new Session({ transport: tr, clock, hello: HELLO });
  s.start();
  tr.deliver(server.welcome(over));
  return { tr, clock, s };
}
const wheel = (t: number) => ({ t_us: t, event_type: "WHEEL", wheel_dx: 0, wheel_dy: 1, wheel_delta_mode: "pixel", target: null });

describe("Session 연결", () => {
  it("첫 프레임은 Sequence 0 HELLO 이고 WELCOME 을 받으면 서버 번호 1에 빈 ACK", () => {
    const { tr, s } = open();
    const [hello, ack1] = tr.decoded();
    expect(hello!.header.seq).toBe(0);
    expect(hello!.control).toEqual({ subtype: "HELLO", ...HELLO });
    expect(ack1!.header).toMatchObject({ msg_type: "ACK", seq: 1, payload_length: 0 });
    expect(s.state).toBe("open");
    expect(s.sessionId).toBe("019a6a3c5e107c4b8f213d9e0b7a4c12");
    expect(s.config.max_unacked_frames).toBe(4);
  });

  it("WELCOME 전에 쌓은 이벤트는 열린 뒤 event_seq 1부터 나감", () => {
    const tr = new FakeTransport();
    const clock = new FakeClock();
    const s = new Session({ transport: tr, clock, hello: HELLO });
    s.start();
    s.push(wheel(10));
    clock.tick(50);
    expect(tr.data()).toHaveLength(0);
    tr.deliver(server.welcome());
    clock.tick(50);
    expect(tr.data()[0]!.events.map((e: Obj) => [e.event_type, e.event_seq])).toEqual([["CHECKPOINT", 1], ["WHEEL", 2]]);
  });

  it("서버 번호가 이어지지 않으면 E_STATE ERROR 를 보내고 4422 로 닫음", () => {
    const { tr, s } = open();
    tr.deliver(server.control(3, changeOrder));
    expect(tr.controls().at(-1)).toMatchObject({ subtype: "ERROR", code: "E_STATE", fatal: true });
    expect(tr.closed).toEqual([4422]);
    expect(s.state).toBe("ended");
  });

  it("같은 번호의 서버 프레임이 다시 와도 E_STATE (연결 안에서 번호는 앞 번호 + 1)", () => {
    const { tr, s } = open();
    const orders: Obj[] = [];
    s.onChangeOrder((o) => orders.push(o));
    const order = server.control(2, changeOrder);
    tr.deliver(order);
    tr.deliver(order);
    expect(orders).toHaveLength(1);
    expect(tr.acks()).toEqual([1, 2]);
    expect(tr.closed).toEqual([4422]);
  });

  it("서버가 DATA 나 HELLO 를 보내면 방향 오류 E_STATE", () => {
    const { tr } = open();
    tr.deliver(server.control(2, { subtype: "FINISH", reason: "submit", last_data_seq: 0, event_count: 0, collection_loss_count: 0 }));
    expect(tr.controls().at(-1)).toMatchObject({ subtype: "ERROR", code: "E_STATE" });
  });

  it("모르는 subtype 은 비치명 E_SUBTYPE 을 알린 뒤 ACK 하고 계속함", () => {
    const { tr, s } = open();
    tr.deliver(server.control(2, { subtype: 0x80, body_hex: "01" }));
    expect(tr.controls().at(-1)).toMatchObject({ subtype: "ERROR", code: "E_SUBTYPE", fatal: false });
    expect(tr.acks()).toEqual([1, 2]);
    expect(s.state).toBe("open");
  });

  it("디코드할 수 없는 바이트는 그 오류 코드로 ERROR 를 보내고 닫음", () => {
    const { tr, s } = open();
    tr.deliver(Uint8Array.from([0x41, 0x56, 0x01, 0x09, ...new Array(20).fill(0)]));
    expect(tr.controls().at(-1)).toMatchObject({ subtype: "ERROR", code: "E_MSG_TYPE", fatal: true });
    expect(tr.closed).toEqual([4400]);
    expect(s.state).toBe("ended");
  });
});

describe("DATA 묶기", () => {
  it("비어 있지 않은 DATA 는 늘 CHECKPOINT 로 시작하고 앞 프레임 없이 좌표가 복원됨", () => {
    const { tr, clock, s } = open();
    s.push({ t_us: 100, event_type: "CHECKPOINT", pointer_known: true, doc_visible: true, window_focused: true, pointer_type: "mouse", x: 10, y: 20, scroll_y: 300, anchor: 0 });
    s.push({ t_us: 116, event_type: "POINTER_MOVE", x: 13, y: 18 });
    clock.tick(50);
    s.push({ t_us: 200, event_type: "POINTER_MOVE", x: 15, y: 18 });
    clock.tick(50);
    const [f1, f2] = tr.data();
    expect(f1!.header.flags).toEqual(["HAS_CHECKPOINT"]);
    expect(f1!.events.map((e: Obj) => [e.event_type, e.event_seq, e.x, e.y])).toEqual([["CHECKPOINT", 1, 10, 20], ["POINTER_MOVE", 2, 13, 18]]);
    expect(f1!.events[0]).toMatchObject({ scroll_y: 300 });
    expect(f2!.header.seq).toBe(2);
    expect(f2!.events.map((e: Obj) => [e.event_type, e.event_seq, e.x, e.y])).toEqual([["CHECKPOINT", 3, 13, 18], ["POINTER_MOVE", 4, 15, 18]]);
  });

  it("위치를 모르는 프레임의 첫 이동은 절대 좌표 CHECKPOINT 뒤 0 이동으로 보냄", () => {
    const { tr, clock, s } = open();
    s.push({ t_us: 100, event_type: "POINTER_MOVE", x: 50, y: 60 });
    s.push({ t_us: 116, event_type: "POINTER_MOVE", x: 52, y: 61 });
    clock.tick(50);
    expect(tr.data()[0]!.events.map((e: Obj) => [e.event_type, e.pointer_known, e.dx, e.dy, e.x, e.y])).toEqual([
      ["CHECKPOINT", false, undefined, undefined, 0, 0],
      ["CHECKPOINT", true, undefined, undefined, 50, 60],
      ["POINTER_MOVE", undefined, 0, 0, 50, 60],
      ["POINTER_MOVE", undefined, 2, 1, 52, 61],
    ]);
  });

  it("프레임 안 이벤트는 t_us 순으로 안정 정렬해 dt 가 0 이상", () => {
    const { tr, clock, s } = open();
    s.push(wheel(300));
    s.push(wheel(100));
    s.push({ ...wheel(100), wheel_dy: 2 });
    clock.tick(50);
    const evs = tr.data()[0]!.events.slice(1);
    expect(evs.map((e: Obj) => [e.t_us, e.wheel_dy])).toEqual([[100, 1], [100, 2], [300, 1]]);
    expect(tr.data()[0]!.header.timestamp_us).toBe(100);
  });

  it("누름, 키, 입력, 페이지 이동, 화면 변화는 50ms 를 기다리지 않고 ACK_REQUESTED 로 바로 나감", () => {
    const { tr, s } = open();
    s.push({ t_us: 5, event_type: "KEY_DOWN", key_category: "letter", trusted: true, repeat: false, is_composing: false, modifier_flags: [], target: null });
    s.push({ t_us: 6, event_type: "INPUT", source: "dom", target: 2, input_type: "insertText", text_length_delta: 6, trusted: true });
    s.push({ t_us: 7, event_type: "NAVIGATION_END", source: "dom", nav_type: "push", route: "/shop" });
    expect(tr.data()).toHaveLength(3);
    for (const f of tr.data()) expect(f.header.flags).toEqual(["HAS_CHECKPOINT", "ACK_REQUESTED"]);
  });

  it("보낼 이벤트가 없으면 keepalive_ms 마다 빈 DATA", () => {
    const { tr, clock } = open({ keepalive_ms: 200 });
    for (let i = 0; i < 3; i++) clock.tick(50);
    expect(tr.data()).toHaveLength(0);
    clock.tick(50);
    expect(tr.data()).toHaveLength(1);
    expect(tr.data()[0]!.header).toMatchObject({ event_count: 0, flags: [], timestamp_us: 200_000 });
  });

  it("인코드할 수 없는 이벤트(사전 밖 av_key)는 COLLECTION_LOSS encode_failed 로 바꾸고 FINISH 수집 누락에 셈", async () => {
    const { tr, clock, s } = open();
    s.push({ t_us: 1, event_type: "TARGET_INFO", target: 1, target_role: "button", av_key: "nope", target_bbox: [0, 0, 1, 1] });
    clock.tick(50);
    expect(tr.data()[0]!.events[1]).toMatchObject({ event_type: "COLLECTION_LOSS", reason: "encode_failed", count: 1 });
    void s.finish();
    expect(tr.controls().find((c) => c.subtype === "FINISH")).toMatchObject({ collection_loss_count: 1 });
  });
});

describe("ACK", () => {
  it("누적 ACK 는 그 번호까지만 pending 에서 지우고, CRC32 를 TX 사본과 대조해 탭에 남김", () => {
    const { tr, clock, s } = open();
    const taps: TapRecord[] = [];
    s.onTap((r) => taps.push(r));
    for (let i = 0; i < 3; i++) {
      s.push(wheel(i));
      clock.tick(50);
    }
    const seqs = () => s.unacked().map((f) => decodeFrame(f).header.seq);
    expect(seqs()).toEqual([1, 2, 3]);
    const sent2 = tr.sent.find((b) => b[3] === 1 && decodeFrame(b).header.seq === 2)!;
    tr.deliver(server.ack(2, sent2));
    expect(seqs()).toEqual([3]);
    expect(taps.at(-1)).toMatchObject({ dir: "rx", msgType: 2, seq: 2, ackCrcMatch: true });
    const tx = taps.filter((r) => r.dir === "tx");
    expect(tx.every((r) => r.byteLength === r.bytes.length && r.decoded)).toBe(true);
  });

  it("CRC32 가 다르면 ackCrcMatch 가 false", () => {
    const { tr, clock, s } = open();
    const taps: TapRecord[] = [];
    s.onTap((r) => taps.push(r));
    s.push(wheel(0));
    clock.tick(50);
    tr.deliver(server.ack(1, Uint8Array.of(1, 2, 3)));
    expect(taps.at(-1)!.ackCrcMatch).toBe(false);
  });

  it("보낸 적 없는 번호의 ACK 는 E_STATE", () => {
    const { tr } = open();
    tr.deliver(server.ack(9));
    expect(tr.controls().at(-1)).toMatchObject({ subtype: "ERROR", code: "E_STATE" });
  });

  it("ACK 못 받은 프레임이 한도에 닿으면 POINTER_MOVE 를 버리고 TRUNCATED 와 COLLECTION_LOSS 로 알림", () => {
    const { tr, clock, s } = open();
    for (let i = 0; i < 4; i++) {
      s.push(wheel(i));
      clock.tick(50);
    }
    s.push({ t_us: 10, event_type: "POINTER_MOVE", x: 1, y: 1 });
    s.push({ t_us: 11, event_type: "POINTER_MOVE", x: 2, y: 1 });
    s.push(wheel(12));
    clock.tick(50);
    const last = tr.data().at(-1)!;
    expect(last.header.flags).toContain("TRUNCATED");
    expect(last.events.map((e: Obj) => e.event_type)).toEqual(["CHECKPOINT", "COLLECTION_LOSS", "WHEEL"]);
    expect(last.events[1]).toMatchObject({ reason: "buffer_overflow", count: 2 });
  });
});

describe("화면 변화", () => {
  it("CHANGE_ORDER 는 콜백으로 넘기고 ACK 함", () => {
    const { tr, s } = open();
    const orders: Obj[] = [];
    s.onChangeOrder((o) => orders.push(o));
    tr.deliver(server.control(2, changeOrder));
    expect(orders).toEqual([changeOrder]);
    expect(tr.acks()).toEqual([1, 2]);
  });

  it("reportChange 성공은 UI_CHANGE_RENDERED 를 보내고 이후 CHECKPOINT 의 앵커를 바꿈. 실패는 앵커를 바꾸지 않음", () => {
    const { tr, clock, s } = open();
    s.reportChange({ anchor: 2, ok: false, reason: "deadline", tUs: 50 });
    s.reportChange({ anchor: 1, ok: true, tUiUs: 900, applyLagUs: 16000, visiblePct: 80 });
    s.push(wheel(950));
    clock.tick(50);
    const frames = tr.data();
    expect(frames[0]!.events[1]).toMatchObject({ event_type: "UI_CHANGE_FAILED", anchor: 2, reason: "deadline" });
    expect(frames[0]!.events[0].anchor).toBe(0);
    expect(frames[1]!.events[1]).toMatchObject({ event_type: "UI_CHANGE_RENDERED", anchor: 1, apply_lag_us: 16000, applied_at_us: -15100 });
    expect(frames.at(-1)!.events[0]).toMatchObject({ event_type: "CHECKPOINT", anchor: 1 });
  });
});

describe("FINISH 와 끝", () => {
  it("FINAL DATA 다음 번호로 FINISH 를 보내고, FINAL 결과와 STATE(ENDED) 로 끝남", async () => {
    const { tr, s } = open();
    const results: Obj[] = [];
    s.onServerMessage((f) => results.push(f));
    s.push(wheel(1));
    const p = s.finish();
    const final = tr.data().at(-1)!;
    expect(final.header.flags).toContain("FINAL");
    const fin = tr.controls().find((c) => c.subtype === "FINISH")!;
    expect(fin).toMatchObject({ seq: final.header.seq + 1, reason: "submit", last_data_seq: final.header.seq, event_count: 2, collection_loss_count: 0 });
    s.push(wheel(2)); // FINISH 뒤 DATA 는 E_STATE 라 보내지 않음
    expect(tr.data()).toHaveLength(1);
    tr.deliver(server.result(2, true));
    tr.deliver(server.state(3, "ENDED", "finish"));
    const end = await p;
    expect(end.reason).toBe("finish");
    expect(end.lastResult).toMatchObject({ ai_score: 0.25, window_id: 2 });
    expect(results.map((f) => f.header.msg_type)).toEqual(["INFERENCE_RESULT", "STATE"]);
    expect(tr.acks()).toEqual([1, 2, 3]);
    expect(s.state).toBe("ended");
    expect(tr.closed).toEqual([1000]);
  });

  it("점수를 낼 근거가 모자라면 STATE(ENDED, insufficient_data) 하나로 끝남", async () => {
    const { tr, s } = open();
    const p = s.finish();
    tr.deliver(server.state(2, "ENDED", "insufficient_data"));
    await expect(p).resolves.toEqual({ reason: "insufficient_data", lastResult: undefined });
  });

  it("FINISH 뒤 3초 안에 서버 프레임이 없으면 timeout 으로 끝남", async () => {
    const { clock, s } = open();
    const p = s.finish();
    for (let i = 0; i < 59; i++) clock.tick(50);
    expect(s.state).toBe("finishing");
    clock.tick(50);
    await expect(p).resolves.toMatchObject({ reason: "timeout" });
  });

  it("FINISH 를 보내기 전 finishing 중 받은 CHANGE_ORDER 는 session_finishing 실패로 보고", () => {
    const { tr, s } = open();
    const orders: Obj[] = [];
    s.onChangeOrder((o) => orders.push(o));
    // finish() 는 FINAL DATA 와 FINISH 를 한 번에 보내므로, 그 사이를 흉내 내려고 상태만 바꿈
    (s as unknown as { state: string }).state = "finishing";
    tr.deliver(server.control(2, changeOrder));
    expect(orders).toEqual([]);
    void s.finish();
    const evs = tr.data().flatMap((f) => f.events);
    expect(evs.find((e: Obj) => e.event_type === "UI_CHANGE_FAILED")).toMatchObject({ anchor: 1, reason: "session_finishing" });
  });

  it("STOP 을 받으면 FINISH(stop) 를 보냄", () => {
    const { tr } = open();
    tr.deliver(server.control(2, { subtype: "STOP", reason: "max_duration" }));
    expect(tr.controls().find((c) => c.subtype === "FINISH")).toMatchObject({ reason: "stop" });
  });

  it("연결이 끊기면 ended(disconnected) 가 되고 새 이벤트는 버리며 finish 는 그 결과로 풀림", async () => {
    const { tr, clock, s } = open();
    tr.deliver(server.result(2));
    tr.drop();
    expect(s.state).toBe("ended");
    const before = tr.sent.length;
    s.push(wheel(1));
    clock.tick(50);
    expect(tr.sent.length).toBe(before);
    await expect(s.finish()).resolves.toMatchObject({ reason: "disconnected", lastResult: { window_id: 2 } });
  });
});
