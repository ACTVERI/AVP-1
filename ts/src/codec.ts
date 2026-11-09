// AVP/1 v0.3.2 인코더와 디코더. 디코드 결과 JSON 모양은 test-vectors/avp1-v0.2.json, avp1-v0.3.json 이 정본입니다.
// py/avp1/codec.py 와 같은 표, 같은 필드 순서를 씁니다. 한쪽을 고치면 다른 쪽도 고치고 왕복 시험으로 확인합니다.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Obj = Record<string, any>;

/** WELCOME 사전. 0번은 빈 문자열 */
export interface Dict {
  targets?: string[];
  routes?: string[];
  states?: string[];
  steps?: string[];
  [kind: string]: string[] | undefined;
}

export class AvpError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export const LIMITS = {
  maxPayload: 65536,
  maxEventsPerFrame: 1024,
  maxEventPayload: 1024,
  maxControlBody: 8192,
  maxJson: 2048,
} as const;
const U32 = 0xffffffff;

export const MSG_TYPES = ["", "DATA", "ACK", "CONTROL", "INFERENCE_RESULT", "MODEL_INPUT", "STATE", "ASSET_CHUNK"] as const;
export const MSG = { DATA: 1, ACK: 2, CONTROL: 3, INFERENCE_RESULT: 4, MODEL_INPUT: 5, STATE: 6, ASSET_CHUNK: 7 } as const;
export const HEADER_FLAGS = ["RETRANSMIT", "FINAL", "HAS_CHECKPOINT", "ACK_REQUESTED", "TRUNCATED"];
export const FLAG = { RETRANSMIT: 1, FINAL: 2, HAS_CHECKPOINT: 4, ACK_REQUESTED: 8, TRUNCATED: 16 } as const;

// ---------- 값 표 ----------

type Table = Record<number, string>;
export const SOURCE: Table = { 0: "dom", 1: "observer", 2: "site", 3: "harness", 4: "sdk", 5: "electron_main", 15: "other" };
export const POINTER_TYPE: Table = { 0: "mouse", 1: "touch", 2: "pen", 3: "unknown" };
export const WHEEL_MODE: Table = { 0: "pixel", 1: "line", 2: "page" };
export const NAV_TYPE: Table = { 1: "initial_load", 2: "reload", 3: "push", 4: "replace", 5: "back_forward", 15: "other" };
export const ROLE: Table = {
  0: "unknown", 1: "button", 2: "link", 3: "text_input", 4: "sensitive_input", 5: "checkbox", 6: "radio", 7: "select",
  8: "textarea", 9: "image", 10: "list_item", 11: "label", 12: "container", 13: "form", 14: "dialog", 15: "other",
};
export const INPUT_TYPE: Table = {
  1: "insertText", 2: "insertFromPaste", 3: "deleteContentBackward", 4: "deleteContentForward", 5: "insertCompositionText",
  6: "insertFromDrop", 7: "historyUndo", 8: "historyRedo", 9: "insertLineBreak", 15: "other",
};
export const KEY_CATEGORY: Table = {
  1: "letter", 2: "digit", 3: "whitespace", 4: "edit", 5: "enter", 6: "navigation", 7: "modifier", 8: "function",
  9: "symbol", 10: "ime", 15: "other",
};
export const LOSS_REASON: Table = { 1: "buffer_overflow", 2: "encode_failed", 3: "before_t0", 4: "clock_backwards", 5: "apply_exception" };
export const CHANGE_FAIL: Table = { 1: "target_missing", 2: "route_mismatch", 3: "deadline", 4: "hidden", 5: "apply_exception", 6: "session_finishing" };
export const CAPTCHA_PHASE: Table = { 1: "shown", 2: "closed" };
export const MODIFIERS = ["shift", "ctrl", "alt", "meta"];

export const SUBTYPES: Table = {
  1: "HELLO", 2: "WELCOME", 3: "CHANGE_ORDER", 4: "FINISH", 5: "STOP", 6: "ERROR", 7: "FEATURE_SCHEMA",
  8: "CAPTCHA_ANSWER", 9: "SCORE_REQUEST", 10: "CAPTCHA_CHALLENGE", 11: "CAPTCHA_RESULT", 12: "RUN_LABEL",
};
export const CLIENT_KIND: Table = { 1: "electron_lab", 2: "browser_sdk" };
export const MISSION_KIND: Table = { 1: "external_site", 2: "custom_mission", 3: "captcha" };
export const DICT_KINDS: Table = { 1: "targets", 2: "routes", 3: "states", 4: "steps" };
export const CHANGE_KIND: Table = { 1: "reorder", 2: "price_update", 3: "inline_error", 4: "async_reload", 15: "custom" };
export const FINISH_REASON: Table = { 1: "submit", 2: "stop", 3: "pagehide", 4: "client_timeout", 5: "user_stop", 6: "blocked" };
export const STOP_REASON: Table = { 1: "max_duration", 2: "limit", 3: "server_shutdown" };
export const ERROR_CODES: Table = {
  1: "E_HEADER", 2: "E_MAGIC", 3: "E_VERSION", 4: "E_MSG_TYPE", 5: "E_FLAGS", 6: "E_LENGTH", 7: "E_TRUNCATED",
  8: "E_VARINT_TOO_LONG", 9: "E_FRAME_TOO_LARGE", 10: "E_EVENT_TOO_LARGE", 11: "E_CONTROL_TOO_LARGE",
  12: "E_CONTROL_BODY", 13: "E_SUBTYPE", 14: "E_HELLO_REQUIRED", 15: "E_STATE", 16: "E_CLIENT_KEY", 17: "E_MISSION",
  18: "E_NO_CHECKPOINT", 19: "E_RANGE", 20: "E_SESSION_LIMIT", 21: "E_RATE_LIMIT", 22: "E_INTERNAL",
};
/** 오류 이름별 WebSocket 닫기 코드(명세 오류 코드 표). E_SUBTYPE 은 비치명이라 닫지 않음 */
export const CLOSE_CODES: Record<string, number | null> = {
  E_HEADER: 4400, E_MAGIC: 4400, E_VERSION: 4426, E_MSG_TYPE: 4400, E_FLAGS: 4400, E_LENGTH: 4400, E_TRUNCATED: 4400,
  E_VARINT_TOO_LONG: 4400, E_FRAME_TOO_LARGE: 4413, E_EVENT_TOO_LARGE: 4413, E_CONTROL_TOO_LARGE: 4413, E_CONTROL_BODY: 4400,
  E_SUBTYPE: null, E_HELLO_REQUIRED: 4401, E_STATE: 4422, E_CLIENT_KEY: 4403, E_MISSION: 4404, E_NO_CHECKPOINT: 4400,
  E_RANGE: 4400, E_SESSION_LIMIT: 4429, E_RATE_LIMIT: 4429, E_INTERNAL: 1011,
};
export const CHALLENGE_REASON: Table = { 1: "final_above_threshold", 2: "sustained_above_threshold", 3: "action_above_threshold" };
// 0, 1 은 v0.3.1 에셋 중계용. iframe 챌린지는 4~6 과 2, 3 을 씀
export const ANSWER_STATUS: Table = { 0: "answered", 1: "asset_error", 2: "timeout", 3: "cancelled", 4: "success", 5: "fail", 6: "frame_error" };
export const CAPTCHA_RESULT: Table = { 0: "fail", 1: "pass", 2: "expired", 3: "error" };
export const STATE_NAME: Table = { 1: "WARMING_UP", 2: "SCORING", 3: "CAPTCHA_PENDING", 4: "CAPTCHA_PASSED", 5: "CAPTCHA_FAILED", 6: "ENDED", 7: "BLOCKED" };
export const STATE_REASON: Table = {
  0: "none", 1: "final_above_threshold", 2: "sustained_above_threshold", 3: "challenge_timeout", 4: "captcha_server_error",
  5: "finish", 6: "limit", 7: "insufficient_data", 8: "model_unavailable", 9: "block_after_captcha_fail",
  10: "block_above_threshold", 11: "action_allowed",
};
export const ACTION_KIND: Table = { 1: "purchase", 2: "transfer", 3: "submit", 4: "other" };
export const CAPTCHA_TRIGGER: Table = { 0: "protected_action", 1: "sustained", 2: "both" };
export const RUN_LABEL: Table = { 0: "unset", 1: "human", 2: "ai_agent" };
export const INPUT_PATH: Table = { 0: "unknown", 1: "physical", 2: "cdp_input", 3: "dom_direct", 4: "mixed" };

// ---------- 레이아웃 ----------
// [필드 이름, 형식, 표나 한도]. 디코더와 인코더가 같은 목록을 읽어 순서가 어긋나지 않게 함

// opt 의 인자는 함께 오거나 함께 빠지는 필드 묶음
type Field = [string, string, (Table | string[] | string | number | Field[])?];

export const CHECKPOINT = 0x50;
const POINTER_BUTTON: Field[] = [["x", "svar"], ["y", "svar"], ["button", "u8"], ["pointer_type", "enum", POINTER_TYPE], ["trusted", "trusted"], ["target", "target"]];
const KEY: Field[] = [["key_category", "enum", KEY_CATEGORY], ["_", "keyflags"], ["modifier_flags", "bits", MODIFIERS], ["target", "target"]];
const NAV: Field[] = [["source", "enum", SOURCE], ["nav_type", "enum", NAV_TYPE], ["route", "route"]];
export const EVENTS: Record<number, [string, Field[]]> = {
  0x01: ["POINTER_MOVE", [["dx", "svar"], ["dy", "svar"]]],
  0x02: ["POINTER_DOWN", POINTER_BUTTON],
  0x03: ["POINTER_UP", POINTER_BUTTON],
  0x10: ["KEY_DOWN", KEY],
  0x11: ["KEY_UP", KEY],
  0x14: ["INPUT", [["source", "enum", SOURCE], ["target", "target"], ["input_type", "enum", INPUT_TYPE], ["text_length_delta", "svar"], ["trusted", "trusted"]]],
  0x20: ["WHEEL", [["wheel_dx", "wheel"], ["wheel_dy", "wheel"], ["wheel_delta_mode", "enum", WHEEL_MODE], ["target", "target"]]],
  0x30: ["TARGET_INFO", [["target", "target"], ["target_role", "enum", ROLE], ["av_key", "dictref", "targets"], ["target_bbox", "bbox"]]],
  0x39: ["PROTECTED_ACTION", [["action_kind", "enum", ACTION_KIND], ["target", "target"]]],
  0x40: ["NAVIGATION_START", NAV],
  0x41: ["NAVIGATION_END", NAV],
  [CHECKPOINT]: ["CHECKPOINT", [["event_seq", "uvar"], ["_", "cpflags"], ["x", "svar"], ["y", "svar"], ["scroll_y", "uvar"], ["anchor", "uvar"]]],
  0x51: ["VIEWPORT_CHANGE", [["viewport_width", "uvar"], ["viewport_height", "uvar"], ["dpr_milli", "uvar"]]],
  0x52: ["COLLECTION_LOSS", [["reason", "enum", LOSS_REASON], ["count", "uvar"]]],
  0x60: ["UI_CHANGE_RENDERED", [["anchor", "uvar"], ["apply_lag_us", "uvar"], ["visible_pct", "u8"]]],
  0x61: ["UI_CHANGE_FAILED", [["anchor", "uvar"], ["reason", "enum", CHANGE_FAIL]]],
  0x62: ["CAPTCHA_VIEW", [["phase", "enum", CAPTCHA_PHASE], ["challenge_no", "uvar"], ["view_x", "svar"], ["view_y", "svar"], ["view_w", "uvar"], ["view_h", "uvar"]]],
};
export const EVENT_CODES: Record<string, number> = Object.fromEntries(Object.entries(EVENTS).map(([k, [n]]) => [n, Number(k)]));

const CONTROLS: Record<number, Field[]> = {
  1: [["proto_minor", "u8"], ["caps", "uvar"], ["client_kind", "enum", CLIENT_KIND], ["mission_kind", "enum", MISSION_KIND], ["run_flags", "u8"],
    ["sdk_version", "str", 128], ["client_key", "str", 128], ["mission_id", "str", 128], ["t0_unix_us", "u64"], ["viewport_width", "uvar"],
    ["viewport_height", "uvar"], ["dpr_milli", "uvar"], ["input_caps", "u8"], ["max_touch_points", "u8"], ["browser_family", "u8"],
    ["browser_major", "uvar"], ["sampling_policy", "u8"], ["env_flags", "u8"], ["timer_resolution_us", "opt_uvar"]],
  2: [["session_id", "hex16"], ["server_open_unix_us", "u64"], ["caps", "uvar"], ["server_flags", "u8"], ["flush_ms", "uvar"],
    ["keepalive_ms", "uvar"], ["infer_interval_ms", "uvar"], ["window_ms", "uvar"], ["min_action_events", "uvar"],
    ["captcha_threshold_milli", "uvar"], ["captcha_sustain_ms", "uvar"], ["max_payload_bytes", "uvar"],
    ["max_events_per_frame", "uvar"], ["max_unacked_frames", "uvar"], ["dict", "dicts"],
    // v0.3 선택 묶음. 둘이 함께 오거나 함께 빠짐
    ["_v03", "opt", [["block_threshold_milli", "u16"], ["captcha_trigger", "enum", CAPTCHA_TRIGGER]]]],
  3: [["anchor", "uvar"], ["kind", "enum", CHANGE_KIND], ["target_av", "dictref", "targets"], ["deadline_ms", "uvar"], ["require_route", "route"], ["params", "json"]],
  4: [["reason", "enum", FINISH_REASON], ["last_data_seq", "uvar"], ["event_count", "uvar"], ["collection_loss_count", "uvar"]],
  5: [["reason", "enum", STOP_REASON]],
  6: [["code", "enum16", ERROR_CODES], ["fatal", "bool"], ["message", "cutstr", 256]],
  7: [["schema_id", "uvar"], ["model_id", "str", 64], ["model_version", "str", 32], ["window_steps", "uvar"], ["features", "names"], ["channels", "channels"]],
  8: [["challenge_id", "str"], ["status", "enum", ANSWER_STATUS], ["answer", "json"],
    // v0.3.2 선택 묶음. iframe 이 success 와 함께 준 1회용 토큰
    ["_v032", "opt", [["verification_token", "str", 128]]]],
  9: [],
  10: [["challenge_id", "str"], ["challenge_no", "uvar"], ["window_id", "u32"], ["reason", "enum", CHALLENGE_REASON], ["ttl_ms", "uvar"],
    ["asset_count", "u8"], ["asset_total_bytes", "uvar"], ["meta", "json"],
    // v0.3.2 선택 묶음. 있으면 iframe 챌린지이고 에셋 필드는 0
    ["_v032", "opt", [["frame_url", "str", 1024]]]],
  11: [["challenge_id", "str"], ["result", "enum", CAPTCHA_RESULT], ["next_state", "enum", STATE_NAME]],
  12: [["label", "enum", RUN_LABEL], ["input_path", "enum", INPUT_PATH], ["set_at_ms", "uvar"]],
};
export const SUBTYPE_CODES: Record<string, number> = Object.fromEntries(Object.entries(SUBTYPES).map(([k, v]) => [v, Number(k)]));
const STATE_LAYOUT: Field[] = [["state", "enum", STATE_NAME], ["reason", "enum", STATE_REASON], ["window_id", "u32"],
  // v0.3.1 선택 묶음. 판단 결과가 가리키는 보호 행동과, 통과일 때 1회용 행동 토큰
  ["_a6", "opt", [["action_event_seq", "uvar"]]], ["_a5", "opt", [["action_token", "hex16"]]]];
const RESULT_LAYOUT: Field[] = [["window_id", "u32"], ["window_start_ms", "uvar"], ["window_end_ms", "uvar"], ["event_count", "uvar"], ["ai_score", "score"]];

const enc = (detail: string) => new AvpError("E_ENCODE", detail);

// ---------- 읽기 ----------

// ignoreBOM 을 켜지 않으면 맨 앞 U+FEFF 를 지워 Python 과 다른 문자열이 되고, json 은 BOM 붙은 것까지 받아 버림
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Reader {
  private dv: DataView;
  constructor(private b: Uint8Array, public i = 0, private end = b.length) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get remaining(): number {
    return this.end - this.i;
  }
  private need(n: number): number {
    if (n > this.remaining) throw new AvpError("E_TRUNCATED");
    const at = this.i;
    this.i += n;
    return at;
  }
  take(n: number): Uint8Array {
    const at = this.need(n);
    return this.b.subarray(at, at + n);
  }
  u8(): number { return this.b[this.need(1)]!; }
  u16(): number { return this.dv.getUint16(this.need(2), true); }
  i16(): number { return this.dv.getInt16(this.need(2), true); }
  u32(): number { return this.dv.getUint32(this.need(4), true); }
  u64(): number {
    const v = this.dv.getBigUint64(this.need(8), true);
    // u64 필드(유닉스 µs)는 JSON 수로 다루므로 2^53 안이어야 정확함
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new AvpError("E_RANGE", "u64 가 2^53-1 초과");
    return Number(v);
  }
  f32(): number {
    const v = this.dv.getFloat32(this.need(4), true);
    if (!Number.isFinite(v)) throw new AvpError("E_RANGE", "f32 가 유한수가 아님");
    return v;
  }
  uvar(): number {
    let n = 0;
    for (let k = 0; k < 5; k++) {
      const x = this.u8();
      // 5번째 바이트는 u32 의 상위 4비트만 담을 수 있음
      if (k === 4 && x > 0x0f) throw new AvpError("E_VARINT_TOO_LONG");
      n += (x & 0x7f) * 2 ** (7 * k);
      if (!(x & 0x80)) return n;
    }
    throw new AvpError("E_VARINT_TOO_LONG");
  }
  svar(): number {
    const z = this.uvar();
    return (z >>> 1) ^ -(z & 1);
  }
  str(limit?: number, limitCode = "E_CONTROL_TOO_LARGE"): string {
    const raw = this.take(this.uvar());
    if (limit !== undefined && raw.length > limit) throw new AvpError(limitCode, `문자열 ${raw.length}B 가 ${limit}B 를 넘음`);
    if (raw.includes(0)) throw new AvpError("E_CONTROL_BODY", "문자열에 NUL");
    try {
      return utf8.decode(raw);
    } catch {
      throw new AvpError("E_CONTROL_BODY", "문자열이 UTF-8 이 아님");
    }
  }
  sub(n: number): Reader {
    const at = this.need(n);
    return new Reader(this.b, at, at + n);
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** json 안 수는 유한하고 절댓값 2^53-1 이하, 글자열에 짝 없는 서로게이트가 없어야 두 언어가 같은 값을 냄 */
function jsonValuesOk(v: unknown): boolean {
  // 깊은 입력에서 재귀 한도로 Python 과 갈리지 않게 스택으로 돈다
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "number") {
      if (!Number.isFinite(x) || Math.abs(x) > Number.MAX_SAFE_INTEGER) return false;
    } else if (typeof x === "string") {
      if (LONE_SURROGATE.test(x)) return false;
    } else if (Array.isArray(x)) {
      stack.push(...x);
    } else if (x && typeof x === "object") {
      for (const [k, y] of Object.entries(x)) {
        if (LONE_SURROGATE.test(k)) return false;
        stack.push(y);
      }
    }
  }
  return true;
}

function readJson(r: Reader): Obj {
  const raw = r.take(r.uvar());
  if (raw.length > LIMITS.maxJson) throw new AvpError("E_CONTROL_TOO_LARGE", `json ${raw.length}B`);
  let v: unknown;
  try {
    v = JSON.parse(utf8.decode(raw));
  } catch {
    throw new AvpError("E_CONTROL_BODY", "json 이 UTF-8 JSON 이 아님");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AvpError("E_CONTROL_BODY", "json 최상위가 객체가 아님");
  if (!jsonValuesOk(v)) throw new AvpError("E_CONTROL_BODY", "json 수가 2^53-1 을 넘거나 유한하지 않음, 또는 짝 없는 서로게이트");
  return v as Obj;
}

const nameOf = (t: Table, n: number): string | number => t[n] ?? n;
function dictName(d: Dict | undefined, key: string, idx: number): string | number {
  const lst = d?.[key] ?? [];
  return idx > 0 && idx < lst.length ? lst[idx]! : idx;
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function readFields(r: Reader, layout: Field[], out: Obj, d?: Dict): void {
  for (const [name, kind, arg] of layout) {
    switch (kind) {
      case "u8": out[name] = r.u8(); break;
      case "u16": out[name] = r.u16(); break;
      case "opt": if (r.remaining) readFields(r, arg as Field[], out, d); break;
      case "u32": out[name] = r.u32(); break;
      case "u64": out[name] = r.u64(); break;
      case "uvar": out[name] = r.uvar(); break;
      case "opt_uvar": if (r.remaining) out[name] = r.uvar(); break;
      case "svar": out[name] = r.svar(); break;
      case "enum": out[name] = nameOf(arg as Table, r.u8()); break;
      case "enum16": out[name] = nameOf(arg as Table, r.u16()); break;
      case "bool": {
        const v = r.u8();
        if (v > 1) throw new AvpError("E_RANGE", `${name} 는 0 또는 1`);
        out[name] = v === 1;
        break;
      }
      case "trusted": out[name] = !!(r.u8() & 1); break;
      case "keyflags": {
        const f = r.u8();
        out.trusted = !!(f & 1); out.repeat = !!(f & 2); out.is_composing = !!(f & 4);
        break;
      }
      case "cpflags": {
        const f = r.u8();
        out.pointer_known = !!(f & 1); out.doc_visible = !!(f & 2); out.window_focused = !!(f & 4);
        out.pointer_type = POINTER_TYPE[(f >> 3) & 3];
        break;
      }
      case "bits": {
        const f = r.u8();
        out[name] = (arg as string[]).filter((_, i) => f & (1 << i));
        break;
      }
      case "target": out[name] = r.uvar() || null; break;
      case "dictref": {
        const v = r.uvar();
        out[name] = v ? dictName(d, arg as string, v) : null;
        break;
      }
      case "route": {
        const v = r.uvar();
        out[name] = v === 0 ? null : !(v & 1) && v >>> 1 ? dictName(d, "routes", v >>> 1) : v;
        break;
      }
      case "bbox": out[name] = [r.svar(), r.svar(), r.uvar(), r.uvar()]; break;
      case "wheel": out[name] = r.svar() / 100; break;
      case "str":
      case "cutstr": out[name] = r.str(arg as number | undefined); break;
      case "hex16": out[name] = hex(r.take(16)); break;
      case "json": out[name] = readJson(r); break;
      case "score": {
        const raw = r.take(4);
        const dv = new DataView(raw.buffer, raw.byteOffset, 4);
        const v = dv.getFloat32(0, true);
        if (!Number.isFinite(v) || v < 0 || v > 1) throw new AvpError("E_RANGE", "ai_score 가 0~1 유한수가 아님");
        out[name] = v;
        out.ai_score_bits = dv.getUint32(0, true).toString(16).toUpperCase().padStart(8, "0");
        break;
      }
      case "dicts": {
        const dicts: Record<string, string[]> = {};
        const seen = new Set<number>();
        for (let k = r.u8(); k > 0; k--) {
          const code = r.u8(), n = r.uvar();
          if (n > 64) throw new AvpError("E_MISSION", `사전 항목 ${n}개`);
          if (seen.has(code)) throw new AvpError("E_MISSION", `사전 종류 ${code} 가 두 번`);
          seen.add(code);
          const lst = [""];
          for (let j = 0; j < n; j++) lst.push(r.str(64, "E_MISSION"));
          // 표 밖 종류는 읽고 버림. 숫자 이름 키를 넣으면 JS 객체가 앞으로 옮겨 순서가 갈림
          const kind = DICT_KINDS[code];
          if (kind) dicts[kind] = lst;
        }
        out[name] = dicts;
        break;
      }
      case "names": {
        const n = r.uvar();
        if (n > 64) throw new AvpError("E_CONTROL_TOO_LARGE", `특징 ${n}개`);
        out[name] = Array.from({ length: n }, () => r.str(64));
        break;
      }
      case "channels": {
        const n = r.uvar();
        if (n > 8) throw new AvpError("E_CONTROL_TOO_LARGE", `채널 ${n}개`);
        out[name] = Array.from({ length: n }, () => ({ name: r.str(64), unit: r.str(64) }));
        break;
      }
      default:
        throw new Error(`레이아웃 형식 ${kind}`);
    }
  }
}

function readExt(r: Reader): Obj {
  const ext: Obj = {};
  const seen = new Set<number>();
  for (let k = r.u8(); k > 0; k--) {
    const tag = r.u8();
    const br = r.sub(r.uvar());
    // 같은 tag 가 다시 오면 처음 것만, 모르는 tag 는 length 만큼 건너뜀
    if (seen.has(tag) || tag < 1 || tag > 5) continue;
    seen.add(tag);
    if (tag === 1) ext.schema_id = br.uvar();
    else if (tag === 2) ext.inference_time_us = br.uvar();
    else if (tag === 3) ext.shape = { steps: br.uvar(), features: br.uvar() };
    else if (tag === 4) {
      const n = br.uvar();
      if (n > 64) continue; // 한도를 넘은 블록만 버림
      ext.features = Array.from({ length: n }, () => ({ id: br.uvar(), value: br.f32() }));
    } else {
      const nch = br.u8(), npt = br.u16();
      if (nch > 8 || npt > 128) continue;
      const channels: Obj[] = [];
      for (let c = 0; c < nch; c++) {
        const id = br.uvar(), scale = br.f32(), offset = br.f32();
        const q = Array.from({ length: npt }, () => br.i16());
        channels.push({ id, scale, offset, q, values: q.map((x) => offset + scale * x) });
      }
      ext.series = { points: npt, channels };
    }
  }
  return ext;
}

function decodeEvents(r: Reader, count: number, ts: number, d?: Dict): Obj[] {
  const events: Obj[] = [];
  let t = ts;
  let firstSeq = 0;
  let pos: [number, number] | null = null;
  for (let k = 0; k < count; k++) {
    const etype = r.u8();
    if (k === 0 && etype !== CHECKPOINT) throw new AvpError("E_NO_CHECKPOINT");
    const length = r.uvar();
    if (length === 0) throw new AvpError("E_TRUNCATED", "이벤트 length 0");
    if (length > LIMITS.maxEventPayload) throw new AvpError("E_EVENT_TOO_LARGE");
    const er = r.sub(length);
    t += er.svar();
    if (t > Number.MAX_SAFE_INTEGER) throw new AvpError("E_RANGE", "이벤트 시각이 2^53-1 초과");
    const e: Obj = { t_us: t, event_seq: firstSeq + k };
    const def = EVENTS[etype];
    if (!def) {
      // dt 는 위에서 더했고 나머지는 건너뜀
      events.push({ ...e, event_type: "UNKNOWN", type_code: etype, length });
      continue;
    }
    const [name, layout] = def;
    e.event_type = name;
    readFields(er, layout, e, d);
    if (k === 0) firstSeq = e.event_seq;
    if (name === "CHECKPOINT") pos = e.pointer_known ? [e.x, e.y] : null;
    else if (name === "POINTER_DOWN" || name === "POINTER_UP") pos = [e.x, e.y];
    else if (name === "POINTER_MOVE" && pos) {
      pos = [pos[0] + e.dx, pos[1] + e.dy];
      [e.x, e.y] = pos;
    } else if (name === "UI_CHANGE_RENDERED") e.applied_at_us = t - e.apply_lag_us;
    events.push(e);
  }
  return events;
}

/** 고정 레이아웃 메시지는 선택 묶음, 확장 블록까지 읽은 뒤 남는 바이트를 받지 않음(검사 순서 11단계) */
function noTrailing(r: Reader, what: string): void {
  if (r.remaining) throw new AvpError("E_LENGTH", `${what} 끝에 ${r.remaining}B 가 남음`);
}

/** 명세 '검사 순서' 1~11단계. 상태와 방향(12단계 이후)은 세션이 봄 */
export function decodeFrame(buf: Uint8Array | string, d?: Dict): Obj {
  if (typeof buf === "string") throw new AvpError("E_MAGIC", "텍스트 메시지");
  if (buf.length < 24) throw new AvpError("E_HEADER", "헤더 24바이트보다 짧음");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x41 || buf[1] !== 0x56) throw new AvpError("E_MAGIC");
  if (buf[2] !== 1) throw new AvpError("E_VERSION");
  const mtype = buf[3]!;
  if (mtype < 1 || mtype > 7) throw new AvpError("E_MSG_TYPE", `Message Type ${mtype}`);
  const flags = dv.getUint16(4, true);
  if (flags & 0xffe0) throw new AvpError("E_FLAGS");
  const plen = dv.getUint32(20, true);
  if (plen > LIMITS.maxPayload) throw new AvpError("E_FRAME_TOO_LARGE");
  if (24 + plen !== buf.length) throw new AvpError("E_LENGTH");
  const tname = MSG_TYPES[mtype]!;
  const count = dv.getUint16(6, true);
  if (tname === "DATA" && count > LIMITS.maxEventsPerFrame) throw new AvpError("E_FRAME_TOO_LARGE");
  if (tname !== "DATA" && count !== 0) throw new AvpError("E_HEADER", `${tname} 의 Event Count 가 0이 아님`);
  const ts = dv.getBigUint64(12, true);
  if (ts > BigInt(Number.MAX_SAFE_INTEGER)) throw new AvpError("E_HEADER", "Timestamp 가 2^53-1 초과");

  const header = {
    version: 1, msg_type: tname, flags: HEADER_FLAGS.filter((_, i) => flags & (1 << i)), event_count: count,
    seq: dv.getUint32(8, true), timestamp_us: Number(ts), payload_length: plen,
  };
  const r = new Reader(buf, 24);
  const out: Obj = { header };
  switch (tname) {
    case "DATA":
      out.events = decodeEvents(r, count, header.timestamp_us, d);
      if (r.remaining) throw new AvpError("E_LENGTH", "Event Count 만큼 읽은 뒤 바이트가 남음");
      break;
    case "ACK":
      // 클라이언트 ACK 는 페이로드가 비어 있음
      if (r.remaining) out.ack = { frame_crc32: r.u32().toString(16).toUpperCase().padStart(8, "0"), decoded_events: r.uvar() };
      noTrailing(r, "ACK");
      break;
    case "CONTROL": {
      const sub = r.u8();
      if (r.remaining > LIMITS.maxControlBody) throw new AvpError("E_CONTROL_TOO_LARGE");
      const layout = CONTROLS[sub];
      if (!layout) {
        // 모르는 subtype 은 비치명 E_SUBTYPE 이라 세션이 정함. 디코더는 본문을 그대로 넘김
        out.control = { subtype: sub, body_hex: hex(r.take(r.remaining)).toUpperCase() };
        break;
      }
      const c: Obj = { subtype: SUBTYPES[sub] };
      readFields(r, layout, c, d);
      if (sub === 1 && c.proto_minor < 2) throw new AvpError("E_VERSION", `proto_minor ${c.proto_minor}`);
      // 끝 바이트는 무시하지만, 확장을 시험하는 쪽이 다시 계산하지 않게 시작 위치를 알려 줌
      if (r.remaining) c.trailing_offset = r.i;
      out.control = c;
      break;
    }
    case "INFERENCE_RESULT": {
      const res: Obj = {};
      readFields(r, RESULT_LAYOUT, res, d);
      if (r.remaining) {
        res.first_event_seq = r.uvar();
        res.last_event_seq = r.uvar();
      }
      if (r.remaining) res.ext = readExt(r);
      noTrailing(r, "INFERENCE_RESULT");
      out.result = res;
      break;
    }
    case "MODEL_INPUT": {
      const window_id = r.u32(), first_event_seq = r.u32(), last_event_seq = r.u32(), dtype = r.u8(), mflags = r.u8();
      const rows = r.u16(), cols = r.u16();
      if (dtype !== 1) throw new AvpError("E_RANGE", `모르는 dtype ${dtype}`);
      const data = Array.from({ length: rows }, () => Array.from({ length: cols }, () => r.f32()));
      noTrailing(r, "MODEL_INPUT");
      out.model_input = { window_id, first_event_seq, last_event_seq, dtype: "f32", downsampled: !!(mflags & 1), rows, cols, data };
      break;
    }
    case "STATE": {
      const st: Obj = {};
      readFields(r, STATE_LAYOUT, st, d);
      noTrailing(r, "STATE");
      out.state = st;
      break;
    }
    default: {
      const challenge_id = r.str(), asset_index = r.u8(), chunk_index = r.u16(), chunk_count = r.u16(), asset_size = r.u32();
      const asset_sha256 = hex(r.take(32));
      out.asset_chunk = { challenge_id, asset_index, chunk_index, chunk_count, asset_size, asset_sha256, data_hex: hex(r.take(r.remaining)).toUpperCase() };
    }
  }
  return out;
}

// ---------- 쓰기 ----------

class Writer {
  bytes: number[] = [];
  get length(): number { return this.bytes.length; }
  u8(v: number): void { this.bytes.push(v & 0xff); }
  raw(b: ArrayLike<number>): void { for (let i = 0; i < b.length; i++) this.bytes.push(b[i]!); }
  fixed(size: 2 | 4 | 8, v: number, signed = false): void {
    const b = new Uint8Array(size);
    const dv = new DataView(b.buffer);
    if (size === 2) signed ? dv.setInt16(0, v, true) : dv.setUint16(0, v, true);
    else if (size === 4) dv.setUint32(0, v, true);
    else dv.setBigUint64(0, BigInt(v), true);
    this.raw(b);
  }
  f32(v: unknown, what: string): void {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isFinite(Math.fround(v))) throw enc(`${what} 가 f32 유한수가 아님: ${v}`);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.raw(b);
  }
  uvar(n: unknown, what = "uvar"): void {
    let v = int(n, 0, U32, what);
    while (v > 0x7f) {
      this.bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v);
  }
  svar(n: unknown, what = "svar"): void {
    const v = int(n, -0x80000000, 0x7fffffff, what);
    this.uvar(((v << 1) ^ (v >> 31)) >>> 0, what);
  }
  str(s: unknown, what: string, limit?: number): void {
    if (typeof s !== "string") throw enc(`${what} 가 문자열이 아님`);
    const b = new TextEncoder().encode(s);
    if (s.includes("\0") || (limit !== undefined && b.length > limit)) throw enc(`${what} 가 NUL 을 담거나 ${limit}B 를 넘음`);
    this.uvar(b.length);
    this.raw(b);
  }
  json(v: unknown, what: string): void {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw enc(`${what} 는 JSON 객체여야 함`);
    // JSON.stringify 는 NaN, Infinity 를 말없이 null 로 바꿔 보낸 값이 달라지므로 Python(allow_nan=False)처럼 거절
    const text = JSON.stringify(v, (_k, x) => {
      if (typeof x === "number" && !Number.isFinite(x)) throw enc(`${what} 에 유한수가 아닌 수: ${x}`);
      return x;
    });
    const b = new TextEncoder().encode(text);
    if (b.length > LIMITS.maxJson) throw enc(`${what} ${b.length}B 가 ${LIMITS.maxJson}B 를 넘음`);
    this.uvar(b.length);
    this.raw(b);
  }
}

/** UTF-8 바이트 limit 안에서 글자(코드 포인트) 경계로 자름 */
function cutUtf8(s: string, limit: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > limit) break;
    bytes += n;
    out += ch;
  }
  return out;
}

function int(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw enc(`${what} 범위 밖: ${v}`);
  return v;
}
function codeOf(t: Table, v: unknown, what: string, max = 0xff): number {
  if (typeof v === "string") {
    const k = Object.keys(t).find((k) => t[Number(k)] === v);
    if (k === undefined) throw enc(`${what} 에 없는 이름: ${v}`);
    return Number(k);
  }
  return int(v, 0, max, what);
}
function dictIndex(d: Dict | undefined, key: string, v: unknown, what: string): number {
  if (typeof v === "string") {
    const i = (d?.[key] ?? []).indexOf(v, 1);
    if (i < 1) throw enc(`${what}: 사전 ${key} 에 없는 값 ${v}`);
    return i;
  }
  return int(v, 0, U32, what);
}
function get(o: Obj, k: string): any {
  if (!(k in o)) throw enc(`필드 ${k} 가 없음`);
  return o[k];
}
function fromHexStrict(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw enc(`${what} 가 hex 가 아님`);
  return fromHex(s);
}

function writeFields(w: Writer, layout: Field[], o: Obj, d?: Dict): void {
  let skippedOpt = false;
  for (const [name, kind, arg] of layout) {
    switch (kind) {
      case "u8": w.u8(int(get(o, name), 0, 0xff, name)); break;
      case "u16": w.fixed(2, int(get(o, name), 0, 0xffff, name)); break;
      case "opt": {
        // 묶음의 첫 필드가 있으면 묶음 전체를 씀. 나머지가 빠졌으면 get 이 E_ENCODE
        const group = arg as Field[];
        if (o[group[0]![0]] != null) {
          if (skippedOpt) throw enc(`${group[0]![0]} 앞 선택 묶음이 빠짐`);
          writeFields(w, group, o, d);
        } else skippedOpt = true;
        break;
      }
      case "u32": w.fixed(4, int(get(o, name), 0, U32, name)); break;
      case "u64": w.fixed(8, int(get(o, name), 0, Number.MAX_SAFE_INTEGER, name)); break;
      case "uvar": w.uvar(get(o, name), name); break;
      case "opt_uvar": if (o[name] != null) w.uvar(o[name], name); break;
      case "svar": w.svar(get(o, name), name); break;
      case "enum": w.u8(codeOf(arg as Table, get(o, name), name)); break;
      case "enum16": w.fixed(2, codeOf(arg as Table, get(o, name), name, 0xffff)); break;
      case "bool":
      case "trusted": w.u8(get(o, name) ? 1 : 0); break;
      case "keyflags": w.u8((get(o, "trusted") ? 1 : 0) | (get(o, "repeat") ? 2 : 0) | (get(o, "is_composing") ? 4 : 0)); break;
      case "cpflags": {
        const pt = codeOf(POINTER_TYPE, get(o, "pointer_type"), "pointer_type", 3);
        w.u8((get(o, "pointer_known") ? 1 : 0) | (get(o, "doc_visible") ? 2 : 0) | (get(o, "window_focused") ? 4 : 0) | (pt << 3));
        break;
      }
      case "bits": {
        let bits = 0;
        for (const n of get(o, name) as string[]) {
          const i = (arg as string[]).indexOf(n);
          if (i < 0) throw enc(`${name} 에 없는 이름: ${n}`);
          bits |= 1 << i;
        }
        w.u8(bits);
        break;
      }
      case "target": { const v = get(o, name); w.uvar(v == null ? 0 : v, name); break; }
      case "dictref": { const v = get(o, name); w.uvar(v == null ? 0 : dictIndex(d, arg as string, v, name), name); break; }
      case "route": {
        const v = get(o, name);
        w.uvar(v == null ? 0 : typeof v === "string" ? dictIndex(d, "routes", v, name) * 2 : v, name);
        break;
      }
      case "bbox": {
        const b = get(o, name);
        if (!Array.isArray(b) || b.length !== 4) throw enc(`${name} 는 [x, y, w, h]`);
        w.svar(b[0], name); w.svar(b[1], name); w.uvar(b[2], name); w.uvar(b[3], name);
        break;
      }
      case "wheel": {
        const v = get(o, name);
        if (typeof v !== "number" || !Number.isFinite(v)) throw enc(`${name} 가 수가 아님`);
        // Python 쪽과 같게 floor(v*100+0.5). Math.round 와 같은 값
        w.svar(Math.floor(v * 100 + 0.5), name);
        break;
      }
      case "str": w.str(get(o, name), name, arg as number | undefined); break;
      case "cutstr": {
        // ERROR message: 오류를 알리는 일이 길이 때문에 실패하지 않게 바이트 한도 안에서 글자 경계로 자름
        const v = get(o, name);
        if (typeof v !== "string") throw enc(`${name} 가 문자열이 아님`);
        w.str(cutUtf8(v, arg as number), name, arg as number);
        break;
      }
      case "hex16": {
        const b = fromHexStrict(get(o, name), name);
        if (b.length !== 16) throw enc(`${name} 는 16바이트`);
        w.raw(b);
        break;
      }
      case "json": w.json(get(o, name), name); break;
      case "score": {
        const v = get(o, name);
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw enc(`ai_score 가 0~1 이 아님: ${v}`);
        const b = new Uint8Array(4);
        const dv = new DataView(b.buffer);
        dv.setFloat32(0, v, true);
        const bits = o.ai_score_bits;
        if (bits != null && String(bits).toUpperCase() !== dv.getUint32(0, true).toString(16).toUpperCase().padStart(8, "0")) {
          throw enc(`ai_score ${v} 와 ai_score_bits ${bits} 가 다름`);
        }
        w.raw(b);
        break;
      }
      case "dicts": {
        const dicts = get(o, name) as Record<string, string[]>;
        const entries = Object.entries(dicts);
        if (entries.length > 0xff) throw enc("사전 종류가 255개를 넘음");
        w.u8(entries.length);
        for (const [key, lst] of entries) {
          if (!Object.values(DICT_KINDS).includes(key)) throw enc(`사전 종류 ${key} 는 표 밖`);
          const code = codeOf(DICT_KINDS, key, "dict kind");
          if (!Array.isArray(lst) || lst[0] !== "" || lst.length - 1 > 64) throw enc(`사전 ${key} 는 빈 문자열로 시작하고 항목 64개 이하`);
          w.u8(code);
          w.uvar(lst.length - 1);
          for (const s of lst.slice(1)) w.str(s, `dict.${key}`, 64);
        }
        break;
      }
      case "names": {
        const names = get(o, name) as string[];
        if (names.length > 64) throw enc("특징이 64개를 넘음");
        w.uvar(names.length);
        for (const s of names) w.str(s, name, 64);
        break;
      }
      case "channels": {
        const chans = get(o, name) as Obj[];
        if (chans.length > 8) throw enc("채널이 8개를 넘음");
        w.uvar(chans.length);
        for (const ch of chans) {
          w.str(get(ch, "name"), "channel name", 64);
          w.str(get(ch, "unit"), "channel unit", 64);
        }
        break;
      }
      default:
        throw new Error(`레이아웃 형식 ${kind}`);
    }
  }
}

function writeExt(w: Writer, ext: Obj): void {
  const blocks: [number, Writer][] = [];
  const block = (tag: number, fill: (b: Writer) => void) => {
    const b = new Writer();
    fill(b);
    blocks.push([tag, b]);
  };
  if ("schema_id" in ext) block(1, (b) => b.uvar(ext.schema_id, "schema_id"));
  if ("inference_time_us" in ext) block(2, (b) => b.uvar(ext.inference_time_us, "inference_time_us"));
  if ("shape" in ext) block(3, (b) => { b.uvar(get(ext.shape, "steps"), "steps"); b.uvar(get(ext.shape, "features"), "features"); });
  if ("features" in ext) {
    const fs = ext.features as Obj[];
    if (fs.length > 64) throw enc("features 가 64개를 넘음");
    block(4, (b) => {
      b.uvar(fs.length);
      for (const f of fs) { b.uvar(get(f, "id"), "feature id"); b.f32(get(f, "value"), "feature value"); }
    });
  }
  if ("series" in ext) {
    const npt = int(get(ext.series, "points"), 0, 128, "points");
    const chans = get(ext.series, "channels") as Obj[];
    if (chans.length > 8) throw enc("series 는 채널 8개까지");
    block(5, (b) => {
      b.u8(chans.length);
      b.fixed(2, npt);
      for (const ch of chans) {
        b.uvar(get(ch, "id"), "channel id");
        b.f32(get(ch, "scale"), "scale");
        b.f32(get(ch, "offset"), "offset");
        const q = get(ch, "q") as number[];
        if (q.length !== npt) throw enc("q 길이가 points 와 다름");
        for (const x of q) b.fixed(2, int(x, -32768, 32767, "q"), true);
      }
    });
  }
  w.u8(blocks.length);
  for (const [tag, b] of blocks) {
    w.u8(tag);
    w.uvar(b.length);
    w.raw(b.bytes);
  }
}

/** 이벤트 하나를 type + length + payload 로. prevUs 는 dt 의 기준 시각 */
export function encodeEvent(e: Obj, prevUs: number, d?: Dict): Uint8Array {
  const t = get(e, "t_us");
  const name = get(e, "event_type");
  let code: number;
  let body: ArrayLike<number>;
  if (name === "UNKNOWN") {
    code = int(get(e, "type_code"), 0, 0xff, "type_code");
    if (EVENTS[code]) throw enc(`type_code 0x${code.toString(16)} 는 등록된 이벤트`);
    body = fromHexStrict(get(e, "raw"), "raw");
    let dt: number;
    try {
      dt = new Reader(body as Uint8Array).svar();
    } catch {
      throw enc("raw 가 dt 로 시작하지 않음");
    }
    if (dt !== t - prevUs) throw enc(`raw 의 dt ${dt} 가 t_us 차이 ${t - prevUs} 와 다름`);
  } else {
    code = EVENT_CODES[name] ?? -1;
    if (code < 0) throw enc(`인코드할 수 없는 이벤트 ${name}`);
    const w = new Writer();
    w.svar(t - prevUs, "dt");
    writeFields(w, EVENTS[code]![1], e, d);
    body = w.bytes;
  }
  if (body.length > LIMITS.maxEventPayload) throw enc(`이벤트 payload ${body.length}B`);
  const w = new Writer();
  w.u8(code);
  w.uvar(body.length);
  w.raw(body);
  return Uint8Array.from(w.bytes);
}

export function buildFrame(type: number, flags: number, count: number, seq: number, tsUs: number, payload: Uint8Array): Uint8Array {
  if (payload.length > LIMITS.maxPayload) throw enc(`페이로드 ${payload.length}B`);
  int(count, 0, type === MSG.DATA ? LIMITS.maxEventsPerFrame : 0, "event_count");
  int(seq, 0, U32, "seq");
  int(tsUs, 0, Number.MAX_SAFE_INTEGER, "timestamp_us");
  const buf = new Uint8Array(24 + payload.length);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x41; buf[1] = 0x56; buf[2] = 1; buf[3] = type;
  dv.setUint16(4, flags, true);
  dv.setUint16(6, count, true);
  dv.setUint32(8, seq, true);
  dv.setBigUint64(12, BigInt(tsUs), true);
  dv.setUint32(20, payload.length, true);
  buf.set(payload, 24);
  return buf;
}

function encodeEvents(events: Obj[], ts: number, d?: Dict): Uint8Array {
  if (events.length > LIMITS.maxEventsPerFrame) throw enc(`이벤트 ${events.length}개`);
  if (events.length && events[0]!.event_type !== "CHECKPOINT") throw enc("비어 있지 않은 DATA 의 첫 이벤트는 CHECKPOINT");
  const parts: Uint8Array[] = [];
  let prev = ts;
  let firstSeq = 0;
  events.forEach((e, k) => {
    if (k === 0) firstSeq = int(get(e, "event_seq"), 0, U32, "event_seq");
    else {
      // event_seq 는 첫 CHECKPOINT 기준 순번. 다른 값을 주면 디코드 결과와 어긋나므로 거절
      const want = firstSeq + k;
      if (e.event_seq != null && e.event_seq !== want) throw enc(`${k}번째 이벤트 event_seq ${e.event_seq} 가 ${want} 가 아님`);
      if (e.event_type === "CHECKPOINT") e = { ...e, event_seq: want };
    }
    parts.push(encodeEvent(e, prev, d));
    prev = e.t_us;
  });
  return concat(parts);
}

/** 디코드 결과와 같은 모양의 객체를 프레임으로. event_count, payload_length 는 다시 계산함 */
export function encodeFrame(f: Obj, d?: Dict): Uint8Array {
  const h = get(f, "header");
  const tname = get(h, "msg_type");
  const mtype = MSG_TYPES.indexOf(tname);
  if (mtype < 1) throw enc(`모르는 msg_type ${tname}`);
  let flags = 0;
  for (const n of h.flags ?? []) {
    const i = HEADER_FLAGS.indexOf(n);
    if (i < 0) throw enc(`모르는 플래그 ${n}`);
    flags |= 1 << i;
  }
  const w = new Writer();
  let count = 0;
  switch (tname) {
    case "DATA": {
      const events: Obj[] = f.events ?? [];
      count = events.length;
      w.raw(encodeEvents(events, get(h, "timestamp_us"), d));
      break;
    }
    case "ACK":
      if (f.ack != null) {
        const crc = get(f.ack, "frame_crc32");
        if (typeof crc !== "string" || !/^[0-9a-fA-F]{1,8}$/.test(crc)) throw enc("frame_crc32 가 hex 가 아님");
        w.fixed(4, parseInt(crc, 16));
        w.uvar(get(f.ack, "decoded_events"), "decoded_events");
      }
      break;
    case "CONTROL": {
      const c = get(f, "control");
      if (typeof c.subtype === "string") {
        const sub = SUBTYPE_CODES[c.subtype];
        if (sub === undefined) throw enc(`모르는 subtype ${c.subtype}`);
        w.u8(sub);
        writeFields(w, CONTROLS[sub]!, c, d);
      } else {
        w.u8(int(c.subtype, 0, 0xff, "subtype"));
        w.raw(fromHexStrict(c.body_hex ?? "", "body_hex"));
      }
      if (w.length - 1 > LIMITS.maxControlBody) throw enc(`CONTROL body ${w.length - 1}B`);
      break;
    }
    case "INFERENCE_RESULT": {
      const res = get(f, "result");
      writeFields(w, RESULT_LAYOUT, res, d);
      const hasRange = res.first_event_seq != null;
      if (res.ext != null && !hasRange) throw enc("확장 블록 앞에 이벤트 번호 범위가 있어야 함");
      if (hasRange) {
        w.uvar(res.first_event_seq, "first_event_seq");
        w.uvar(get(res, "last_event_seq"), "last_event_seq");
      }
      if (res.ext != null) writeExt(w, res.ext);
      break;
    }
    case "MODEL_INPUT": {
      const m = get(f, "model_input");
      if ((m.dtype ?? "f32") !== "f32") throw enc("dtype 은 f32 만");
      const rows = int(get(m, "rows"), 0, 0xffff, "rows"), cols = int(get(m, "cols"), 0, 0xffff, "cols");
      const data = get(m, "data") as number[][];
      if (data.length !== rows || data.some((row) => row.length !== cols) || rows * cols * 4 > 65518) {
        throw enc("data 가 rows × cols 와 다르거나 65,518B 를 넘음");
      }
      w.fixed(4, int(get(m, "window_id"), 0, U32, "window_id"));
      w.fixed(4, int(get(m, "first_event_seq"), 0, U32, "first_event_seq"));
      w.fixed(4, int(get(m, "last_event_seq"), 0, U32, "last_event_seq"));
      w.u8(1);
      w.u8(m.downsampled ? 1 : 0);
      w.fixed(2, rows);
      w.fixed(2, cols);
      for (const row of data) for (const x of row) w.f32(x, "data");
      break;
    }
    case "STATE":
      writeFields(w, STATE_LAYOUT, get(f, "state"), d);
      break;
    default: {
      const a = get(f, "asset_chunk");
      w.str(get(a, "challenge_id"), "challenge_id");
      w.u8(int(get(a, "asset_index"), 0, 0xff, "asset_index"));
      w.fixed(2, int(get(a, "chunk_index"), 0, 0xffff, "chunk_index"));
      w.fixed(2, int(get(a, "chunk_count"), 0, 0xffff, "chunk_count"));
      w.fixed(4, int(get(a, "asset_size"), 0, U32, "asset_size"));
      const sha = fromHexStrict(get(a, "asset_sha256"), "asset_sha256");
      if (sha.length !== 32) throw enc("asset_sha256 은 32바이트");
      w.raw(sha);
      w.raw(fromHexStrict(get(a, "data_hex"), "data_hex"));
    }
  }
  return buildFrame(mtype, flags, count, get(h, "seq"), get(h, "timestamp_us"), Uint8Array.from(w.bytes));
}

// ---------- 도구 ----------

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

export function fromHex(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "");
  if (t.length % 2) throw new Error(`hex 길이가 홀수: ${t.length}`);
  return Uint8Array.from(t.match(/../g) ?? [], (b) => parseInt(b, 16));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

let CRC_TABLE: Uint32Array | undefined;
/** CRC-32(IEEE). Python zlib.crc32 와 같은 값. ACK 의 frame_crc32 와 TX 사본을 비교할 때 씀 */
export function crc32(b: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256(FIPS 180-4). CAPTCHA 에셋 확인용. WebCrypto 는 비동기이고 보안 문맥이 필요해 session 을 가짜 시계로 시험할 수 없어 직접 둠 */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  dv.setUint32(padded.length - 4, (len * 8) >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + SHA_K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0; h[1] = (h[1]! + b!) >>> 0; h[2] = (h[2]! + c!) >>> 0; h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0; h[5] = (h[5]! + f!) >>> 0; h[6] = (h[6]! + g!) >>> 0; h[7] = (h[7]! + hh!) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]!, false);
  return out;
}
