import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.PYTHON ?? "python";
// 전체 판(2만 건 이상)은 tools/fuzz/fuzz.py 를 직접 돌림. 여기는 매번 도는 짧은 판
const TOTAL = Number(process.env.AVP_FUZZ_TOTAL ?? 1000);
const SEED = Number(process.env.AVP_FUZZ_SEED ?? 20261109);

describe("TS와 Python 디코더 차등 퍼징(짧은 판)", () => {
  it(`이상한 입력 ${TOTAL}건에서 두 디코더가 같은 결과를 내고 규격 밖 예외, 멈춤, 1초 넘는 처리가 없음`, () => {
    let out: string;
    try {
      out = execFileSync(python, [join(root, "tools/fuzz/fuzz.py"), "--total", String(TOTAL), "--seed", String(SEED)], {
        cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 300_000,
      });
    } catch (e) {
      // 종료 코드 1이면 실패 묶음 목록이 stdout 에 있으니 그대로 보여 줌
      throw new Error(String((e as { stdout?: string }).stdout ?? e));
    }
    expect(out).toContain(`총 ${TOTAL}건`);
    expect(out).toContain("버그와 불일치 0묶음");
  }, 320_000);
});
