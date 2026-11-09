// docs/architecture.md 의 층 규칙을 src 의 import 로 검사함
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** 파일마다 import 해도 되는 같은 폴더 모듈. 여기 없는 파일이 생기면 문서와 이 표를 함께 고침 */
export const ALLOWED: Record<string, string[]> = {
  codec: [],
  token: ["codec"],
  session: ["codec"],
  "transport-ws": ["codec", "session"],
  collector: ["codec", "session"],
  change: ["codec", "session", "collector"],
  sdk: ["codec", "session", "transport-ws", "collector", "change"],
  index: ["codec", "session", "transport-ws", "collector", "change", "sdk", "token"],
  browser: ["codec", "session", "transport-ws", "collector", "change", "sdk"],
};
/** DOM 없이 Node 에서 돌아야 하는 층 */
const PURE = ["codec", "token", "session"];
const DOM_GLOBALS = /\b(window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|IntersectionObserver|WebSocket|Blob)\b/;

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
}

export function readGraph(dir = SRC): Map<string, { local: string[]; external: string[]; code: string }> {
  const g = new Map<string, { local: string[]; external: string[]; code: string }>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(dir + f, "utf8");
    const specs = [...text.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]!);
    g.set(f.replace(/\.ts$/, ""), {
      local: specs.filter((s) => s.startsWith("./")).map((s) => s.slice(2).replace(/\.js$/, "")),
      external: specs.filter((s) => !s.startsWith(".")),
      code: strip(text),
    });
  }
  return g;
}

export function findCycle(g: Map<string, { local: string[] }>): string[] | null {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of g.get(n)?.local ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.get(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of g.keys()) if (!state.get(n)) { const c = visit(n); if (c) return c; }
  return null;
}

describe("층 규칙", () => {
  const g = readGraph();

  it("모든 src 파일이 층 표에 있음", () => {
    expect([...g.keys()].filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it("각 파일은 허용된 층만 import 함", () => {
    const bad = [...g].flatMap(([f, n]) => n.local.filter((m) => !(ALLOWED[f] ?? []).includes(m)).map((m) => `${f} -> ${m}`));
    expect(bad).toEqual([]);
  });

  it("외부 패키지와 Node 내장 모듈은 token 만 씀(번들이 의존성 없이 돌도록)", () => {
    const bad = [...g].flatMap(([f, n]) => (f === "token" ? n.external.filter((s) => !s.startsWith("node:")) : n.external).map((s) => `${f} -> ${s}`));
    expect(bad).toEqual([]);
  });

  it("codec, token, session 은 DOM 전역을 쓰지 않음", () => {
    const bad = PURE.filter((f) => g.has(f) && DOM_GLOBALS.test(g.get(f)!.code));
    expect(bad).toEqual([]);
  });

  it("import 순환이 없음", () => {
    expect(findCycle(g)).toBeNull();
  });

  it("검사 함수가 순환과 금지 import 를 실제로 잡음", () => {
    const fake = new Map([["a", { local: ["b"] }], ["b", { local: ["c"] }], ["c", { local: ["a"] }]]);
    expect(findCycle(fake)).toEqual(["a", "b", "c", "a"]);
    expect(DOM_GLOBALS.test(strip("const w = window.innerWidth;"))).toBe(true);
    expect(DOM_GLOBALS.test(strip('// window 를 쓰지 않음\nconst s = "document";'))).toBe(false);
  });
});
