// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Collector } from "../src/collector.js";
import { decodeFrame, encodeFrame, type Dict, type Obj } from "../src/codec.js";
import { Session, type Clock, type Transport } from "../src/session.js";

const dict: Dict = { targets: ["", "search_box", "result_list"], routes: ["", "/shop"] };
const hdr = (msg_type: string, seq: number) => ({ version: 1, msg_type, flags: [], event_count: 0, seq, timestamp_us: 0, payload_length: 0 });

describe("수집기 -> Session -> codec", () => {
  it("여러 프레임으로 나뉜 이동, 누름, 키 없는 입력이 프레임마다 혼자 디코드되고 event_seq 가 빠짐없이 이어짐", () => {
    const sent: Uint8Array[] = [];
    let onMsg: (b: Uint8Array) => void = () => {};
    const transport: Transport = { send: (b) => sent.push(b), onMessage: (cb) => (onMsg = cb), onClose: () => {}, close: () => {} };
    let flushTimer: () => void = () => {};
    let nowUs = 0;
    const clock: Clock = { now: () => nowUs, setInterval: (fn) => ((flushTimer = fn), 1), clearInterval: () => {} };
    const session = new Session({ transport, clock, hello: {
      proto_minor: 2, caps: 0, client_kind: "electron_lab", mission_kind: "custom_mission", run_flags: 4, sdk_version: "t", client_key: "k",
      mission_id: "m", t0_unix_us: 0, viewport_width: 0, viewport_height: 0, dpr_milli: 1000, input_caps: 0, max_touch_points: 0,
      browser_family: 1, browser_major: 1, sampling_policy: 0, env_flags: 0,
    } });
    session.start();
    onMsg(encodeFrame({ header: hdr("CONTROL", 1), control: {
      subtype: "WELCOME", session_id: "00".repeat(16), server_open_unix_us: 0, caps: 0, server_flags: 15, flush_ms: 50, keepalive_ms: 15000,
      infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 0, captcha_sustain_ms: 10000,
      max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict,
    } }));

    let perfMs = 0;
    const collector = new Collector({ sink: session, dict, originMs: 0, now: () => perfMs, checkpointMs: 60000 });
    document.body.innerHTML = `<ul data-av="result_list"><li id="item">x</li></ul><input id="q" data-av="search_box">`;
    collector.start();

    const fired: [number, number][] = [];
    const move = (x: number, y: number, ms: number) => {
      const ev = new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, isPrimary: true });
      Object.defineProperty(ev, "timeStamp", { value: ms });
      document.dispatchEvent(ev);
      fired.push([x, y]);
    };

    // 프레임 3개에 걸쳐 이동하고, 중간에 누름, fill() 모양의 입력, 앵커 전환을 넣음
    let ms = 10;
    for (let frame = 0; frame < 3; frame++) {
      for (let k = 0; k < 4; k++) move(100 + frame * 20 + k * 3, 200 - k * 2, (ms += 16));
      if (frame === 1) {
        const down = new PointerEvent("pointerdown", { clientX: 140, clientY: 190, bubbles: true, isPrimary: true });
        Object.defineProperty(down, "timeStamp", { value: (ms += 5) });
        document.getElementById("item")!.dispatchEvent(down);
        fired.push([140, 190]);
        const q = document.getElementById("q") as HTMLInputElement;
        q.value = "검색어";
        const input = new InputEvent("input", { inputType: "insertText", bubbles: true });
        Object.defineProperty(input, "timeStamp", { value: (ms += 5) });
        q.dispatchEvent(input);
      }
      if (frame === 2) collector.setAnchor(1, ms * 1000);
      nowUs = ms * 1000;
      flushTimer();
    }
    collector.stop();

    const data = sent.map((b) => decodeFrame(b, dict)).filter((f) => f.header.msg_type === "DATA");
    expect(data.length).toBeGreaterThanOrEqual(3);
    let nextSeq = 1;
    for (const f of data) {
      expect(f.events[0].event_type).toBe("CHECKPOINT");
      for (const e of f.events) expect(e.event_seq).toBe(nextSeq++);
      // 디코더가 x, y 를 채웠다는 것은 프레임 안에서 기준 위치를 찾았다는 뜻
      for (const e of f.events.filter((e: Obj) => e.event_type === "POINTER_MOVE")) expect(e.x).toBeTypeOf("number");
    }
    const all = data.flatMap((f) => f.events);
    const positions = all.filter((e: Obj) => e.event_type === "POINTER_MOVE" || e.event_type === "POINTER_DOWN").map((e: Obj) => [e.x, e.y]);
    // 수집기는 처음 안 위치를 이동 대신 CHECKPOINT 로 보내므로 첫 좌표는 빠짐
    expect(positions).toEqual(fired.slice(1));
    expect(all.find((e: Obj) => e.event_type === "NAVIGATION_END")).toMatchObject({ nav_type: "initial_load" });
    expect(all.find((e: Obj) => e.event_type === "INPUT")).toMatchObject({ text_length_delta: 3, target: 2 });
    expect(all.filter((e: Obj) => e.event_type === "TARGET_INFO").map((e: Obj) => e.av_key)).toEqual(["result_list", "search_box"]);
    expect(data.at(-1)!.events.filter((e: Obj) => e.event_type === "CHECKPOINT").at(-1).anchor).toBe(1);
  });
});
