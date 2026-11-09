import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AvpError, CLOSE_CODES, crc32, decodeFrame, encodeFrame, ERROR_CODES, fromHex, toHex, type Obj } from "../src/codec.js";

const load = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../test-vectors/${name}`, import.meta.url)), "utf8"));
const file = load("avp1-v0.2.json");
const extra = load("avp1-v0.2-extra.json");
const v3 = load("avp1-v0.3.json");
const v31 = load("avp1-v0.3.1.json");
const v32 = load("avp1-v0.3.2.json");
const F32 = new Set<string>(file.compare.f32_fields);
const byId: Record<string, Obj> = Object.fromEntries(file.vectors.map((v: Obj) => [v.id, v]));

/** 명세 비교 규칙: f32 필드는 양쪽을 f32로 반올림한 뒤 비교 */
function norm(o: unknown, f32 = false): unknown {
  if (Array.isArray(o)) return o.map((v) => norm(v, f32));
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, norm(v, f32 || F32.has(k))]));
  return f32 && typeof o === "number" ? Math.fround(o) : o;
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AvpError)) throw e;
    return e.code;
  }
  return undefined;
}

describe("골든 벡터 TV1~TV22", () => {
  it("파일에 TV1부터 TV22까지 순서대로 있음", () => {
    expect(file.vectors.map((v: Obj) => v.id)).toEqual(Array.from({ length: 22 }, (_, i) => `TV${i + 1}`));
  });

  for (const v of file.vectors) {
    if (v.error) {
      it(`${v.id} 디코드는 ${v.error}`, () => {
        expect(errorCode(() => decodeFrame(fromHex(v.hex), file.dict))).toBe(v.error);
      });
      continue;
    }
    it(`${v.id} 디코드 결과가 기대 JSON과 같음`, () => {
      expect(norm(decodeFrame(fromHex(v.hex), file.dict))).toEqual(norm(v.expected));
    });
    it(`${v.id} 기대 JSON을 인코드하면 같은 hex`, () => {
      expect(toHex(encodeFrame(v.encode_input ?? v.expected, file.dict))).toBe(v.hex);
    });
  }

  it("TV7 의 CRC32 는 TV5 프레임 전체의 CRC32", () => {
    const tv5 = fromHex(byId.TV5!.hex);
    expect(decodeFrame(fromHex(byId.TV7!.hex)).ack).toEqual({ frame_crc32: crc32(tv5).toString(16).toUpperCase().padStart(8, "0"), decoded_events: 3 });
  });

  it("TV12 조각의 SHA-256 이 asset_sha256 과 같음", () => {
    const c = decodeFrame(fromHex(byId.TV12!.hex)).asset_chunk;
    expect(createHash("sha256").update(fromHex(c.data_hex)).digest("hex")).toBe(c.asset_sha256);
  });

  it("TV6 모르는 이벤트의 dt 를 더해 뒤 이벤트가 6,006,000µs", () => {
    expect(decodeFrame(fromHex(byId.TV6!.hex), file.dict).events[2].t_us).toBe(6_006_000);
  });
});

describe("명세 밖 경계 사례(extra)", () => {
  for (const v of extra.vectors) {
    if (v.error) {
      it(`${v.id} ${v.name}: ${v.error}`, () => {
        expect(errorCode(() => decodeFrame(fromHex(v.hex), extra.dict))).toBe(v.error);
      });
      continue;
    }
    it(`${v.id} ${v.name}: 디코드`, () => {
      expect(decodeFrame(fromHex(v.hex), extra.dict)).toEqual(v.expected);
    });
    if (v.encode === false) continue;
    it(`${v.id} ${v.name}: 인코드`, () => {
      expect(toHex(encodeFrame(v.expected, extra.dict))).toBe(v.hex);
    });
  }

  it("텍스트 메시지는 E_MAGIC", () => {
    expect(errorCode(() => decodeFrame("hello"))).toBe("E_MAGIC");
  });
});

describe("골든 벡터 TV23~TV35(v0.3)", () => {
  it("파일에 TV23부터 TV35까지 순서대로 있음", () => {
    expect(v3.vectors.map((v: Obj) => v.id)).toEqual(Array.from({ length: 13 }, (_, i) => `TV${i + 23}`));
  });

  for (const v of v3.vectors) {
    it(`${v.id} 디코드 결과가 기대 JSON과 같음`, () => {
      expect(norm(decodeFrame(fromHex(v.hex), v3.dict))).toEqual(norm(v.expected));
    });
    if (v.encode === false) continue;
    it(`${v.id} 기대 JSON을 인코드하면 같은 hex`, () => {
      expect(toHex(encodeFrame(v.encode_input ?? v.expected, v3.dict))).toBe(v.hex);
    });
  }
});

describe("골든 벡터 TV36~TV73(v0.3.1)", () => {
  it("파일에 TV36부터 TV73까지 순서대로 있음", () => {
    expect(v31.vectors.map((v: Obj) => v.id)).toEqual(Array.from({ length: 38 }, (_, i) => `TV${i + 36}`));
  });

  for (const v of v31.vectors) {
    if (v.error) {
      it(`${v.id} ${v.name}: ${v.error}`, () => {
        expect(errorCode(() => decodeFrame(fromHex(v.hex), v31.dict))).toBe(v.error);
      });
      continue;
    }
    it(`${v.id} 디코드 결과가 기대 JSON과 같음`, () => {
      expect(norm(decodeFrame(fromHex(v.hex), v31.dict))).toEqual(norm(v.expected));
    });
    if (v.encode === false) continue;
    it(`${v.id} 기대 JSON을 인코드하면 같은 hex`, () => {
      expect(toHex(encodeFrame(v.expected, v31.dict))).toBe(v.hex);
    });
  }
});

describe("골든 벡터 TV74~TV87(v0.3.2)", () => {
  it("파일에 TV74부터 TV87까지 순서대로 있음", () => {
    expect(v32.vectors.map((v: Obj) => v.id)).toEqual(Array.from({ length: 14 }, (_, i) => `TV${i + 74}`));
  });

  for (const v of v32.vectors) {
    if (v.error) {
      it(`${v.id} ${v.name}: ${v.error}`, () => {
        expect(errorCode(() => decodeFrame(fromHex(v.hex)))).toBe(v.error);
      });
      continue;
    }
    it(`${v.id} 디코드 결과가 기대 JSON과 같음`, () => {
      expect(decodeFrame(fromHex(v.hex))).toEqual(v.expected);
    });
    it(`${v.id} 기대 JSON을 인코드하면 같은 hex`, () => {
      expect(toHex(encodeFrame(v.expected))).toBe(v.hex);
    });
  }

  it("인코더는 frame_url 1,025B, verification_token 129B 를 보내지 않고 E_ENCODE", () => {
    const tv = (id: string) => v32.vectors.find((v: Obj) => v.id === id);
    const ch = structuredClone(tv("TV78").expected);
    ch.control.frame_url += "a";
    expect(errorCode(() => encodeFrame(ch))).toBe("E_ENCODE");
    const an = structuredClone(tv("TV80").expected);
    an.control.verification_token += "t";
    expect(errorCode(() => encodeFrame(an))).toBe("E_ENCODE");
  });
});

describe("v0.3 코덱 경계", () => {
  const ctl = (c: Obj) => ({ header: { version: 1, msg_type: "CONTROL", flags: [], event_count: 0, seq: 1, timestamp_us: 0, payload_length: 0 }, control: c });

  it("CLOSE_CODES 는 오류 표의 이름을 모두 덮고 E_SUBTYPE 은 닫지 않음", () => {
    expect(new Set(Object.keys(CLOSE_CODES))).toEqual(new Set(Object.values(ERROR_CODES)));
    expect(CLOSE_CODES.E_SUBTYPE).toBeNull();
    expect([CLOSE_CODES.E_STATE, CLOSE_CODES.E_VERSION, CLOSE_CODES.E_HELLO_REQUIRED, CLOSE_CODES.E_FRAME_TOO_LARGE, CLOSE_CODES.E_CLIENT_KEY, CLOSE_CODES.E_INTERNAL])
      .toEqual([4422, 4426, 4401, 4413, 4403, 1011]);
  });

  for (const [msg, want] of [["a".repeat(256), "a".repeat(256)], ["a".repeat(257), "a".repeat(256)], ["a".repeat(255) + "가", "a".repeat(255)], ["😀".repeat(70), "😀".repeat(64)], ["", ""]] as const) {
    it(`ERROR message ${new TextEncoder().encode(msg).length}B 는 256바이트 안에서 글자 경계로 잘림`, () => {
      expect(decodeFrame(encodeFrame(ctl({ subtype: "ERROR", code: "E_STATE", fatal: true, message: msg }))).control.message).toBe(want);
    });
  }

  it("끝 바이트가 없으면 trailing_offset 키가 없음", () => {
    expect(decodeFrame(encodeFrame(ctl({ subtype: "STOP", reason: "limit" }))).control).not.toHaveProperty("trailing_offset");
  });

  it("WELCOME v0.3 묶음은 두 필드가 함께 있어야 하고 u16 범위 안이어야 함", () => {
    const base = {
      subtype: "WELCOME", session_id: "00".repeat(16), server_open_unix_us: 0, caps: 0, server_flags: 0, flush_ms: 50, keepalive_ms: 15000,
      infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 800, captcha_sustain_ms: 10000,
      max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: {},
    };
    const code = (c: Obj) => { try { encodeFrame(ctl(c)); } catch (e) { return (e as AvpError).code; } return undefined; };
    expect(code({ ...base, block_threshold_milli: 900 })).toBe("E_ENCODE");
    expect(code({ ...base, block_threshold_milli: 70000, captcha_trigger: "protected_action" })).toBe("E_ENCODE");
    const got = decodeFrame(encodeFrame(ctl({ ...base, block_threshold_milli: 0, captcha_trigger: 2 }))).control;
    expect([got.block_threshold_milli, got.captcha_trigger]).toEqual([0, "both"]);
  });
});

describe("퍼징으로 찾은 사례(avp1-fuzz-findings.json)", () => {
  const fz = load("avp1-fuzz-findings.json");
  const at = (o: Obj, path: string) => path.split(".").reduce((x, k) => x?.[k], o);
  for (const f of fz.findings.filter((f: Obj) => f.check)) {
    const buf = fromHex(f.hex);
    if (f.check.error) {
      it(`${f.id} ${f.title}: ${f.check.error}`, () => {
        expect(errorCode(() => decodeFrame(buf, fz.dict))).toBe(f.check.error);
      });
      continue;
    }
    it(`${f.id} ${f.title}`, () => {
      const dec = decodeFrame(buf, fz.dict);
      if (f.check.field && "value_json" in f.check) expect(at(dec, f.check.field)).toEqual(f.check.value_json);
      else if (f.check.field) expect(at(dec, f.check.field)).toBe(f.check.value);
      if (f.check.also_error) expect(errorCode(() => decodeFrame(fromHex(f.also_hex), fz.dict))).toBe(f.check.also_error);
      if (f.check.reencode === "same_hex") expect(toHex(encodeFrame(dec, fz.dict))).toBe(f.hex);
      else if (f.check.reencode) expect(errorCode(() => encodeFrame(dec, fz.dict))).toBe(f.check.reencode.error);
    });
  }
});
