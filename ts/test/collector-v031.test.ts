// @vitest-environment happy-dom
// v0.3.1 A17 개인정보: 민감 판정 범위, 한 번 민감했던 칸, 숫자 칸 키 분류
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Collector } from "../src/collector.js";
import type { Dict, Obj } from "../src/codec.js";

const dict: Dict = { targets: ["", "search_box"], routes: ["", "/shop"] };
let events: Obj[];
let collector: Collector;

function fire<T extends Event>(target: EventTarget, ev: T, timeStampMs: number): T {
  Object.defineProperty(ev, "timeStamp", { value: timeStampMs });
  target.dispatchEvent(ev);
  return ev;
}
const $ = (sel: string) => document.querySelector(sel)! as HTMLInputElement;
const key = (el: Element, k: string, ts: number) => {
  fire(el, new KeyboardEvent("keydown", { key: k, bubbles: true }), ts);
  fire(el, new KeyboardEvent("keyup", { key: k, bubbles: true }), ts + 0.5);
};
const ofType = (t: string) => events.filter((e) => e.event_type === t);

beforeEach(() => {
  document.body.innerHTML = `
    <input id="plain">
    <input id="pw" type="password">
    <input id="num" inputmode="numeric">
    <input id="tel" autocomplete="tel">
    <input id="bday" autocomplete="bday-day">
    <input id="amt" autocomplete="transaction-amount">`;
  events = [];
  collector = new Collector({ sink: { push: (e) => events.push(e) }, dict, originMs: 1000, now: () => 1000, checkpointMs: 1e9 });
  collector.start();
  events = [];
});
afterEach(() => collector.stop());

describe("A17 민감 판정", () => {
  it("포커스가 민감 칸에 있으면 다른 칸을 대상으로 한 INPUT 도 보내지 않음", () => {
    $("#pw").focus();
    const plain = $("#plain");
    plain.value = "abc";
    fire(plain, new InputEvent("input", { inputType: "insertText", bubbles: true }), 1001);
    expect(ofType("INPUT")).toEqual([]);
  });

  it("한 번 민감했던 칸은 type 을 바꿔도(비밀번호 보기) 계속 민감", () => {
    const pw = $("#pw");
    fire(pw, new FocusEvent("focusin", { bubbles: true }), 1001);
    pw.setAttribute("type", "text");
    key(pw, "a", 1002);
    pw.value = "a";
    fire(pw, new InputEvent("input", { inputType: "insertText", bubbles: true }), 1003);
    expect(ofType("KEY_DOWN")).toEqual([]);
    expect(ofType("INPUT")).toEqual([]);
  });
});

describe("A17 숫자 칸 키 분류", () => {
  for (const sel of ["#num", "#tel", "#bday", "#amt"]) {
    it(`${sel} 칸의 키는 글자, 숫자, 편집 구별 없이 하나의 분류(other)`, () => {
      const el = $(sel);
      fire(el, new FocusEvent("focusin", { bubbles: true }), 1001);
      ["1", "a", "Backspace", "Enter"].forEach((k, i) => key(el, k, 1002 + i));
      expect(new Set(ofType("KEY_DOWN").map((e) => e.key_category))).toEqual(new Set(["other"]));
      expect(ofType("KEY_DOWN")).toHaveLength(4);
    });
  }

  it("보통 칸은 그대로 나눔", () => {
    const el = $("#plain");
    ["1", "a"].forEach((k, i) => key(el, k, 1002 + i));
    expect(ofType("KEY_DOWN").map((e) => e.key_category)).toEqual(["digit", "letter"]);
  });
});
