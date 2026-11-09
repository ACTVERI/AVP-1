// 차등 퍼저의 TS 쪽 일꾼. tools/fuzz/fuzz.py 가 띄우고 표준 입력으로 hex 를 한 줄씩 보냅니다.
// 시험 대상은 빌드된 dist 가 아니라 src/codec.ts 그대로라서, 시작할 때 esbuild 로 묶어 임시 파일에서 읽습니다.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "avp1-fuzz-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const out = join(dir, "codec.mjs");
await build({ entryPoints: [join(here, "../src/codec.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "warning" });
const { AvpError, decodeFrame, encodeFrame, fromHex } = await import(pathToFileURL(out).href);
const dict = JSON.parse(readFileSync(join(here, "../../test-vectors/avp1-v0.2.json"), "utf8")).dict;

const hex = (b) => Array.from(b, (x) => x.toString(16).toUpperCase().padStart(2, "0")).join("");
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 길이 정보(payload_length, trailing_offset)를 뺀 디코드 값. 남는 바이트를 버린 재인코드가 같은 값인지 볼 때 씀
function value(dec) {
  const { payload_length, ...header } = dec.header;
  const out = { ...dec, header };
  if (out.control) {
    const { trailing_offset, ...control } = out.control;
    out.control = control;
  }
  return out;
}

// 키 순서는 보지 않음. 확장 블록은 선로 순서대로 키가 생겨 다시 인코드하면 순서만 바뀔 수 있음
function deepEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return Object.is(a, b) || a === b;
}

function runOne(buf) {
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  let res;
  try {
    const dec = decodeFrame(buf, dict);
    res = { ok: true, decoded: dec };
    try {
      const re = encodeFrame(dec, dict);
      res.reenc = hex(re);
      if (!same(re, buf)) {
        try {
          res.redecode_same = deepEqual(value(decodeFrame(re, dict)), value(dec));
        } catch (e) {
          res.redecode_same = false;
          res.redecode_err = e instanceof AvpError ? e.code : String(e);
        }
      }
    } catch (e) {
      if (e instanceof AvpError) res.reenc_err = e.message;
      else res.reenc_exc = `${e?.name}: ${e?.message}`.slice(0, 300);
    }
  } catch (e) {
    // 규격 오류가 아닌 예외는 모두 버그 후보라 이름째 넘김
    res = e instanceof AvpError ? { ok: false, code: e.code } : { ok: false, exc: `${e?.name}: ${e?.message}`.slice(0, 300) };
  }
  res.ms = performance.now() - t0;
  res.mem_mb = Math.max(0, process.memoryUsage().heapUsed - heap0) / 2 ** 20;
  return res;
}

process.stdout.write("ready\n");
for await (const line of createInterface({ input: process.stdin })) {
  const t = line.trim();
  // 빈 프레임은 빈 줄과 구별하려고 "-" 로 받음
  // JSON.stringify 는 NaN, Infinity 를 null 로 바꾸므로 py_worker 와 같은 이름(repr)으로 옮겨 값끼리 비교되게 함
  const nonFinite = (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? (Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf") : x);
  process.stdout.write(JSON.stringify(runOne(t === "-" ? new Uint8Array(0) : fromHex(t)), nonFinite) + "\n");
}
