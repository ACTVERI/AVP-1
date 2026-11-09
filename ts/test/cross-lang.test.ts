import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTION_KIND, ANSWER_STATUS, CAPTCHA_RESULT, CAPTCHA_TRIGGER, CHALLENGE_REASON, CHANGE_FAIL, CHANGE_KIND, CLIENT_KIND, decodeFrame, encodeFrame, ERROR_CODES,
  FINISH_REASON, fromHex, INPUT_PATH, INPUT_TYPE, KEY_CATEGORY, LOSS_REASON, MISSION_KIND, MODIFIERS, NAV_TYPE, POINTER_TYPE,
  ROLE, RUN_LABEL, SOURCE, STATE_NAME, STATE_REASON, STOP_REASON, toHex, WHEEL_MODE, type Obj,
} from "../src/codec.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dict = JSON.parse(readFileSync(join(root, "test-vectors/avp1-v0.2.json"), "utf8")).dict;
const python = process.env.PYTHON ?? "python";
const CASES = 400;
// 다른 시드로 더 돌려 볼 때만 AVP_CROSS_SEED 를 줌
const SEED = Number(process.env.AVP_CROSS_SEED ?? 20261109);
// Windows 콘솔 기본 인코딩(cp949)으로는 Python 출력의 한글이 깨짐
const pyEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** py/avp1/cross.py 의 _Gen 과 같은 공간을 덮는 무작위 프레임. 난수열은 달라도 됨 */
function generator(rnd: () => number) {
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length)]!;
  const enumOf = (t: Record<number, string>) => (rnd() < 0.05 ? int(0, 256) : pick(Object.values(t)));
  const text = () => Array.from({ length: int(0, 12) }, () => pick([..."abc_xyz019가나다é"])).join("");
  const f = () => rnd() * 2000 - 1000;
  const target = () => (rnd() < 0.3 ? null : int(1, 5000));
  const route = () => pick<string | number | null>([null, "/shop", "/shop/cart", int(0, 500) * 2 + 1]);
  // 키가 "9" 처럼 배열 번호 모양이면 JS 객체가 키 순서를 바꿔 hex 가 달라짐(명세 사본 json 규칙). 접두어로 피함
  const js = () => Object.fromEntries(Array.from({ length: int(0, 3) }, () => ["k" + text(), pick<unknown>([int(-99, 99), text(), [1, "b"], { n: null }])]));
  const bytesHex = (n: number) => toHex(Uint8Array.from({ length: n }, () => int(0, 256))).replace(/ /g, "");
  const zz = (dt: number) => {
    let z = ((dt << 1) ^ (dt >> 31)) >>> 0;
    const out: number[] = [];
    while (z > 0x7f) { out.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
    out.push(z);
    return toHex(Uint8Array.from(out)).replace(/ /g, "");
  };

  // 홀수 천분의 일이라 정수 모양(2.0)이 나오지 않음. JS 와 Python 이 같은 JSON 바이트를 씀
  const thousandths = () => (int(0, 1e6) * 2 + 1) / 1000;
  const trajectory = (): Obj => ({
    v: 1, n: int(0, 2000), durationMs: int(0, 60000), pathLengthPx: thousandths(), straightness: thousandths(), speedMean: thousandths(),
    speedCV: thousandths(), pauseCount: int(0, 50), subMovements: int(0, 50), jitterPx: thousandths(), maxJumpPx: thousandths(),
    dtCV: thousandths(), speedProfile: Array.from({ length: int(0, 25) }, thousandths),
  });
  const checkpoint = (t: number): Obj => ({
    t_us: t, event_type: "CHECKPOINT", pointer_known: rnd() < 0.8, doc_visible: rnd() < 0.9, window_focused: rnd() < 0.9,
    pointer_type: pick(Object.values(POINTER_TYPE)), x: int(-100, 3000), y: int(-100, 3000), scroll_y: int(0, 50000), anchor: int(0, 4),
  });
  const event = (t: number): Obj => {
    switch (int(0, 15)) {
      case 0: return { t_us: t, event_type: "POINTER_MOVE", dx: int(-300, 301), dy: int(-300, 301) };
      case 1: return { t_us: t, event_type: pick(["POINTER_DOWN", "POINTER_UP"]), x: int(-200, 3000), y: int(-200, 3000), button: int(0, 5), pointer_type: enumOf(POINTER_TYPE), trusted: rnd() < 0.5, target: target() };
      case 2: return { t_us: t, event_type: pick(["KEY_DOWN", "KEY_UP"]), key_category: enumOf(KEY_CATEGORY), trusted: rnd() < 0.5, repeat: rnd() < 0.2, is_composing: rnd() < 0.2, modifier_flags: MODIFIERS.filter(() => rnd() < 0.3), target: target() };
      case 3: return { t_us: t, event_type: "INPUT", source: enumOf(SOURCE), target: target(), input_type: enumOf(INPUT_TYPE), text_length_delta: int(-50, 51), trusted: rnd() < 0.5 };
      case 4: return { t_us: t, event_type: "WHEEL", wheel_dx: int(-100000, 100001) / 100, wheel_dy: int(-100000, 100001) / 100, wheel_delta_mode: enumOf(WHEEL_MODE), target: target() };
      case 5: return { t_us: t, event_type: "TARGET_INFO", target: int(1, 5000), target_role: enumOf(ROLE), av_key: pick([null, "search_box", "result_list", "cart_button", 9]), target_bbox: [int(-500, 3000), int(-500, 3000), int(0, 2000), int(0, 2000)] };
      case 6: return { t_us: t, event_type: pick(["NAVIGATION_START", "NAVIGATION_END"]), source: enumOf(SOURCE), nav_type: enumOf(NAV_TYPE), route: route() };
      case 7: return { t_us: t, event_type: "VIEWPORT_CHANGE", viewport_width: int(0, 5000), viewport_height: int(0, 5000), dpr_milli: int(500, 4000) };
      case 8: return { t_us: t, event_type: "COLLECTION_LOSS", reason: enumOf(LOSS_REASON), count: int(0, 100000) };
      case 9: return { t_us: t, event_type: "UI_CHANGE_RENDERED", anchor: int(0, 10), apply_lag_us: int(0, 100000), visible_pct: int(0, 101) };
      case 10: return { t_us: t, event_type: "UI_CHANGE_FAILED", anchor: int(0, 10), reason: enumOf(CHANGE_FAIL) };
      case 11: return { t_us: t, event_type: "CAPTCHA_VIEW", phase: pick(["shown", "closed"]), challenge_no: int(1, 4), view_x: int(-100, 2000), view_y: int(-100, 2000), view_w: int(0, 2000), view_h: int(0, 2000) };
      case 12: return { t_us: t, event_type: "UNKNOWN", type_code: pick([0x6e, 0x80, 0xf3]), extra: bytesHex(int(0, 6)) };
      case 13: return { t_us: t, event_type: "PROTECTED_ACTION", action_kind: enumOf(ACTION_KIND), target: target() };
      default: return checkpoint(t);
    }
  };
  const data = (h: Obj): Obj => {
    let t = int(0, 900_000_000);
    h.timestamp_us = t;
    const seq0 = int(1, 100000);
    const events: Obj[] = [];
    for (let k = 0, n = int(0, 30); k < n; k++) {
      // 프레임 안 정렬이 깨진 이벤트도 디코더는 받음
      if (k) t = Math.max(0, t + int(-2000, 60000));
      events.push({ ...(k === 0 ? checkpoint(t) : event(t)), event_seq: seq0 + k });
    }
    let prev = h.timestamp_us;
    for (const e of events) {
      if (e.event_type === "UNKNOWN") {
        e.raw = zz(e.t_us - prev) + e.extra;
        delete e.extra;
      }
      prev = e.t_us;
    }
    h.flags = events.length ? ["HAS_CHECKPOINT"] : [];
    return { header: h, events };
  };
  const control = (h: Obj): Obj => {
    let c: Obj;
    switch (int(0, 13)) {
      case 0:
        c = { subtype: "HELLO", proto_minor: int(2, 256), caps: int(0, 16), client_kind: enumOf(CLIENT_KIND), mission_kind: enumOf(MISSION_KIND), run_flags: int(0, 8), sdk_version: text(), client_key: text(), mission_id: text(), t0_unix_us: int(0, 2 ** 53), viewport_width: int(0, 5000), viewport_height: int(0, 5000), dpr_milli: int(0, 4000), input_caps: int(0, 16), max_touch_points: int(0, 256), browser_family: int(0, 16), browser_major: int(0, 200), sampling_policy: int(0, 3), env_flags: int(0, 16) };
        if (rnd() < 0.5) c.timer_resolution_us = int(0, 1000);
        break;
      case 1: {
        const kinds = ["targets", "routes", "states", "steps"].filter(() => rnd() < 0.5);
        c = { subtype: "WELCOME", session_id: bytesHex(16).toLowerCase(), server_open_unix_us: int(0, 2 ** 53), caps: 0, server_flags: int(0, 16), flush_ms: 50, keepalive_ms: 15000, infer_interval_ms: int(100, 3000), window_ms: 10000, min_action_events: 3, captcha_threshold_milli: int(0, 1001), captcha_sustain_ms: 10000, max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: Object.fromEntries(kinds.map((k) => [k, ["", ...Array.from({ length: int(0, 5) }, text)]])) };
        if (rnd() < 0.5) {
          c.block_threshold_milli = int(0, 1001);
          c.captcha_trigger = enumOf(CAPTCHA_TRIGGER);
        }
        break;
      }
      case 2: c = { subtype: "CHANGE_ORDER", anchor: int(1, 20), kind: enumOf(CHANGE_KIND), target_av: pick([null, "search_box", "result_list", 7]), deadline_ms: int(0, 10000), require_route: route(), params: js() }; break;
      case 3: c = { subtype: "FINISH", reason: enumOf(FINISH_REASON), last_data_seq: int(0, 10000), event_count: int(0, 100000), collection_loss_count: int(0, 100) }; break;
      case 4: c = { subtype: "STOP", reason: enumOf(STOP_REASON) }; break;
      case 5: c = { subtype: "ERROR", code: pick([...Object.values(ERROR_CODES), 999]), fatal: rnd() < 0.5, message: text() }; break;
      case 6: c = { subtype: "FEATURE_SCHEMA", schema_id: int(1, 10), model_id: text(), model_version: text(), window_steps: int(0, 300), features: Array.from({ length: int(0, 6) }, text), channels: Array.from({ length: int(0, 5) }, () => ({ name: text(), unit: text() })) }; break;
      case 7:
        c = { subtype: "CAPTCHA_ANSWER", challenge_id: text(), status: enumOf(ANSWER_STATUS), answer: js() };
        if (rnd() < 0.5) c.answer = { ...c.answer, elapsed_ms: int(0, 120000), trajectory: trajectory() };
        break;
      case 8: c = { subtype: "SCORE_REQUEST" }; break;
      case 9: c = { subtype: "CAPTCHA_CHALLENGE", challenge_id: text(), challenge_no: int(1, 4), window_id: int(0, 2 ** 32), reason: enumOf(CHALLENGE_REASON), ttl_ms: int(0, 120000), asset_count: int(0, 9), asset_total_bytes: int(0, 524289), meta: js() }; break;
      case 10: c = { subtype: "CAPTCHA_RESULT", challenge_id: text(), result: enumOf(CAPTCHA_RESULT), next_state: enumOf(STATE_NAME) }; break;
      case 11: c = { subtype: "RUN_LABEL", label: enumOf(RUN_LABEL), input_path: enumOf(INPUT_PATH), set_at_ms: int(0, 900000) }; break;
      default: c = { subtype: int(13, 256), body_hex: bytesHex(int(0, 6)) };
    }
    return { header: h, control: c };
  };
  return (seq: number): Obj => {
    const kind = pick(["DATA", "DATA", "DATA", "ACK", "CONTROL", "CONTROL", "INFERENCE_RESULT", "MODEL_INPUT", "STATE", "ASSET_CHUNK"]);
    const h: Obj = { version: 1, msg_type: kind, flags: [], event_count: 0, seq, timestamp_us: int(0, 2 ** 40), payload_length: 0 };
    switch (kind) {
      case "DATA": return data(h);
      case "ACK": return rnd() < 0.7 ? { header: h, ack: { frame_crc32: int(0, 2 ** 32).toString(16).toUpperCase().padStart(8, "0"), decoded_events: int(0, 1025) } } : { header: h };
      case "CONTROL": return control(h);
      case "INFERENCE_RESULT": {
        if (rnd() < 0.3) h.flags = ["FINAL"];
        const res: Obj = { window_id: int(1, 2 ** 32), window_start_ms: int(0, 1e6), window_end_ms: int(0, 1e6), event_count: int(0, 5000), ai_score: rnd() };
        if (rnd() < 0.7) {
          res.first_event_seq = int(1, 1e5);
          res.last_event_seq = int(1, 1e5);
          if (rnd() < 0.6) {
            const ext: Obj = {};
            if (rnd() < 0.7) ext.schema_id = int(1, 9);
            if (rnd() < 0.7) ext.inference_time_us = int(0, 1e6);
            if (rnd() < 0.7) ext.shape = { steps: int(0, 256), features: int(0, 64) };
            if (rnd() < 0.7) ext.features = Array.from({ length: int(0, 6) }, () => ({ id: int(1, 65), value: f() }));
            if (rnd() < 0.7) {
              const npt = int(0, 9);
              ext.series = { points: npt, channels: Array.from({ length: int(0, 4) }, () => ({ id: int(1, 9), scale: f(), offset: f(), q: Array.from({ length: npt }, () => int(-32768, 32768)) })) };
            }
            res.ext = ext;
          }
        }
        return { header: h, result: res };
      }
      case "MODEL_INPUT": {
        const rows = int(0, 4), cols = int(0, 4);
        return { header: h, model_input: { window_id: int(0, 2 ** 32), first_event_seq: int(0, 99), last_event_seq: int(0, 99), dtype: "f32", downsampled: rnd() < 0.3, rows, cols, data: Array.from({ length: rows }, () => Array.from({ length: cols }, f)) } };
      }
      case "STATE": return { header: h, state: { state: enumOf(STATE_NAME), reason: enumOf(STATE_REASON), window_id: int(0, 2 ** 32) } };
      default: return { header: h, asset_chunk: { challenge_id: text(), asset_index: int(0, 8), chunk_index: int(0, 16), chunk_count: int(1, 17), asset_size: int(0, 524289), asset_sha256: bytesHex(32).toLowerCase(), data_hex: bytesHex(int(0, 40)) } };
    }
  };
}

describe("TS와 Python 왕복(v0.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "avp1-cross-"));

  it(`TS가 인코드한 무작위 프레임 ${CASES}개를 Python이 같은 JSON으로 디코드하고 같은 입력을 같은 hex로 인코드`, () => {
    const gen = generator(mulberry32(SEED));
    const cases = Array.from({ length: CASES }, (_, i) => {
      const input = gen(i + 1);
      const buf = encodeFrame(input, dict);
      return { input, hex: toHex(buf), decoded: decodeFrame(buf, dict) };
    });
    // 메시지 종류가 고루 섞였는지. 한 종류라도 빠지면 시험이 그 방향을 보지 않음
    expect(new Set(cases.map((c) => c.input.header.msg_type)).size).toBe(7);
    const file = join(dir, "ts-cases.json");
    writeFileSync(file, JSON.stringify(cases));
    const out = execFileSync(python, ["-m", "avp1.cross", "check", file], { cwd: join(root, "py"), encoding: "utf8", env: pyEnv });
    expect(out).toContain(`${CASES}/${CASES} 일치`);
  });

  it(`Python이 인코드한 무작위 프레임 ${CASES}개를 TS가 같은 JSON으로 디코드하고 같은 입력을 같은 hex로 인코드`, () => {
    const file = join(dir, "py-cases.json");
    execFileSync(python, ["-m", "avp1.cross", "gen", String(SEED), String(CASES), file], { cwd: join(root, "py"), encoding: "utf8", env: pyEnv });
    const cases: { input: Obj; hex: string; decoded: Obj }[] = JSON.parse(readFileSync(file, "utf8"));
    expect(cases).toHaveLength(CASES);
    let n = 0;
    for (const c of cases) {
      expect(decodeFrame(fromHex(c.hex), dict)).toEqual(c.decoded);
      expect(toHex(encodeFrame(c.input, dict))).toBe(c.hex);
      n++;
    }
    expect(n).toBe(CASES);
  });
});
