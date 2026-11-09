// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collector, isSensitive, keyCategory, roleOf } from "../src/collector.js";
import { decodeFrame, encodeFrame, type Dict, type Obj } from "../src/codec.js";

const dict: Dict = { targets: ["", "search_box", "result_list", "cart_button"], routes: ["", "/shop", "/shop/cart"] };

function fire<T extends Event>(target: EventTarget, ev: T, timeStampMs: number): T {
  Object.defineProperty(ev, "timeStamp", { value: timeStampMs });
  target.dispatchEvent(ev);
  return ev;
}

let events: Obj[];
let collector: Collector;
let clock: number;
const ORIGIN = 1000;

function makeCollector(over: Partial<ConstructorParameters<typeof Collector>[0]> = {}) {
  return new Collector({ sink: { push: (e) => events.push(e) }, dict, originMs: ORIGIN, now: () => clock, checkpointMs: 1e9, ...over });
}

beforeEach(() => {
  document.body.innerHTML = `
    <input data-av="search_box" value="secret-value">
    <input id="pw" type="password">
    <input id="otp" autocomplete="one-time-code">
    <div data-av-ignore><input id="ignored"></div>
    <ul data-av="result_list"><li><span id="name">상품명텍스트</span></li></ul>
    <div data-av="not_in_dict" id="nodict"></div>
    <button id="plain">구매</button>`;
  events = [];
  clock = ORIGIN;
  collector = makeCollector();
  collector.start();
  events = []; // 시작할 때 보낸 첫 화면 NAVIGATION_END 는 따로 시험함
});

afterEach(() => {
  collector.stop();
  vi.useRealTimers();
});

const $ = (sel: string) => document.querySelector(sel)!;
const move = (x: number, y: number, ts: number, init: PointerEventInit = {}) =>
  fire(document, new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, isPrimary: true, ...init }), ts);
const types = () => events.map((e) => e.event_type);

describe("수집하지 않는 정보", () => {
  it("키 값, 입력 글자, 페이지 글자는 어떤 이벤트에도 실리지 않음", () => {
    const input = $("input") as HTMLInputElement;
    fire(input, new FocusEvent("focusin", { bubbles: true }), 1001);
    for (const [i, key] of ["q", "Q", "Enter", "Backspace"].entries()) {
      fire(input, new KeyboardEvent("keydown", { key, code: "KeyQ", keyCode: 81, bubbles: true }), 1002 + i);
      fire(input, new KeyboardEvent("keyup", { key, code: "KeyQ", keyCode: 81, bubbles: true }), 1002.5 + i);
    }
    input.value = "secret-value!";
    fire(input, new InputEvent("input", { inputType: "insertText", data: "!", bubbles: true }), 1010);
    fire($("#name"), new PointerEvent("pointerdown", { isPrimary: true, clientX: 5, clientY: 6, bubbles: true }), 1011);

    const json = JSON.stringify(events);
    for (const leaked of ["secret-value", "상품명텍스트", "KeyQ", "\"q\"", "\"Q\"", "Backspace", "\"key\"", "\"code\"", "keyCode", "구매", "\"!\""]) {
      expect(json).not.toContain(leaked);
    }
    expect(events.filter((e) => e.event_type === "KEY_DOWN")).toHaveLength(4);
    expect(events.filter((e) => e.event_type === "KEY_UP")).toHaveLength(4);
    expect(events.find((e) => e.event_type === "INPUT")).toMatchObject({ text_length_delta: 1, input_type: "insertText", source: "dom" });
  });

  it("민감 칸(password, one-time-code, data-av-ignore 아래)에서는 키와 INPUT 을 보내지 않음", () => {
    for (const sel of ["#pw", "#otp", "#ignored"]) {
      const el = $(sel) as HTMLInputElement;
      fire(el, new FocusEvent("focusin", { bubbles: true }), 1001);
      fire(el, new KeyboardEvent("keydown", { key: "a", bubbles: true }), 1002);
      fire(el, new KeyboardEvent("keyup", { key: "a", bubbles: true }), 1003);
      el.value = "abc";
      fire(el, new InputEvent("input", { inputType: "insertText", bubbles: true }), 1004);
    }
    expect(events).toEqual([]);
    expect(isSensitive($("#pw"))).toBe(true);
    expect(isSensitive($("input"))).toBe(false);
  });

  it("민감 칸을 누르면 대상은 role sensitive_input 으로만 알림", () => {
    fire($("#pw"), new PointerEvent("pointerdown", { isPrimary: true, clientX: 1, clientY: 2, bubbles: true }), 1001);
    expect(events[0]).toMatchObject({ event_type: "TARGET_INFO", target_role: "sensitive_input", av_key: null });
  });
});

describe("키 분류(명세 key_category 표)", () => {
  it("위에서부터 처음 맞는 줄", () => {
    const cases: [string, string][] = [
      ["a", "letter"], ["가", "letter"], ["7", "digit"], [" ", "whitespace"], ["Backspace", "edit"], ["Delete", "edit"],
      ["Enter", "enter"], ["Tab", "navigation"], ["ArrowLeft", "navigation"], ["PageDown", "navigation"], ["Shift", "modifier"],
      ["CapsLock", "modifier"], ["Escape", "function"], ["F12", "function"], ["!", "symbol"], ["Process", "ime"], ["Unidentified", "other"],
    ];
    expect(cases.map(([k]) => [k, keyCategory(k)])).toEqual(cases);
    expect(keyCategory("a", true)).toBe("ime");
  });

  it("KEY_DOWN, KEY_UP 으로 나누고 repeat, is_composing, 수식키를 실음", () => {
    fire($("input"), new KeyboardEvent("keydown", { key: "A", shiftKey: true, ctrlKey: true, repeat: true, bubbles: true }), 1001);
    fire($("input"), new KeyboardEvent("keyup", { key: "Process", isComposing: true, bubbles: true }), 1002);
    expect(events.slice(1)).toEqual([
      { t_us: 1000, event_type: "KEY_DOWN", key_category: "letter", trusted: false, repeat: true, is_composing: false, modifier_flags: ["shift", "ctrl"], target: 1 },
      { t_us: 2000, event_type: "KEY_UP", key_category: "ime", trusted: false, repeat: false, is_composing: true, modifier_flags: [], target: 1 },
    ]);
  });
});

describe("대상 번호", () => {
  it("요소마다 세션 번호를 매기고 처음 쓸 때만 같은 시각에 TARGET_INFO 를 보냄", () => {
    fire($("#name"), new PointerEvent("pointerdown", { isPrimary: true, clientX: 5, clientY: 6, bubbles: true }), 1001);
    fire($("#name"), new PointerEvent("pointerup", { isPrimary: true, clientX: 5, clientY: 6, bubbles: true }), 1002);
    fire($("#plain"), new PointerEvent("pointerdown", { isPrimary: true, clientX: 7, clientY: 8, bubbles: true }), 1003);
    expect(types()).toEqual(["TARGET_INFO", "POINTER_DOWN", "POINTER_UP", "TARGET_INFO", "POINTER_DOWN"]);
    expect(events[0]).toEqual({ t_us: 1000, event_type: "TARGET_INFO", target: 1, target_role: "other", av_key: "result_list", target_bbox: [0, 0, 0, 0] });
    expect(events[2]!.target).toBe(1);
    expect(events[3]).toMatchObject({ target: 2, target_role: "button", av_key: null });
  });

  it("role 은 태그, type, ARIA role 로 정함", () => {
    const el = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild!; };
    expect(roleOf(el(`<a href="/x">x</a>`))).toBe("link");
    expect(roleOf(el(`<input type="search">`))).toBe("text_input");
    expect(roleOf(el(`<input type="checkbox">`))).toBe("checkbox");
    expect(roleOf(el(`<div role="button">x</div>`))).toBe("button");
    expect(roleOf(el(`<textarea></textarea>`))).toBe("textarea");
    expect(roleOf(el(`<input autocomplete="cc-number">`))).toBe("sensitive_input");
  });
});

describe("시각과 좌표", () => {
  it("관측 시각은 핸들러 실행 시각이 아니라 event.timeStamp 에서 HELLO 시각을 뺀 µs", () => {
    clock = 99999;
    fire($("input"), new KeyboardEvent("keydown", { key: "a", bubbles: true }), 1012.3456);
    expect(events.at(-1)!.t_us).toBe(12346);
  });

  it("뷰포트 밖 음수 좌표를 자르지 않고 그대로 보냄", () => {
    fire(document, new PointerEvent("pointerdown", { isPrimary: true, clientX: -12.6, clientY: -3.2, bubbles: true }), 1001);
    expect(events.at(-1)).toMatchObject({ event_type: "POINTER_DOWN", x: -13, y: -3 });
  });
});

describe("포인터 이동", () => {
  it("pointermove 는 합치지 않고 브라우저가 보낸 대로 하나씩 보냄(sampling_policy raw)", () => {
    fire(document, new PointerEvent("pointerdown", { isPrimary: true, clientX: 100, clientY: 100, bubbles: true }), 1001);
    events = [];
    move(101, 100, 1002);
    move(103, 99, 1003);
    move(107.6, 97.2, 1004);
    expect(events).toEqual([
      { t_us: 2000, event_type: "POINTER_MOVE", dx: 1, dy: 0, x: 101, y: 100 },
      { t_us: 3000, event_type: "POINTER_MOVE", dx: 2, dy: -1, x: 103, y: 99 },
      { t_us: 4000, event_type: "POINTER_MOVE", dx: 5, dy: -2, x: 108, y: 97 },
    ]);
  });

  it("주 포인터가 아닌 이동과 누름은 버림", () => {
    move(1, 1, 1001, { isPrimary: false });
    fire(document, new PointerEvent("pointerdown", { clientX: 1, clientY: 1, bubbles: true, isPrimary: false }), 1002);
    expect(events).toEqual([]);
  });

  it("위치를 모르는 상태의 첫 이동은 그 위치를 담은 CHECKPOINT 로 기준을 세움", () => {
    move(50, 60, 1002);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "CHECKPOINT", pointer_known: true, x: 50, y: 60, t_us: 2000, anchor: 0 });
  });
});

describe("체크포인트와 앵커", () => {
  it("checkpointMs 마다 위치, 보임, 포커스, 스크롤, 현재 앵커를 담은 CHECKPOINT", () => {
    collector.stop();
    vi.useFakeTimers();
    collector = makeCollector({ checkpointMs: 1000 });
    collector.start();
    fire(document, new PointerEvent("pointerdown", { isPrimary: true, clientX: 640, clientY: 360, bubbles: true }), 1001);
    events = [];
    clock = 2000;
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events[0]).toMatchObject({ t_us: 1_000_000, event_type: "CHECKPOINT", pointer_known: true, x: 640, y: 360, anchor: 0, scroll_y: 0 });

    collector.setAnchor(2, 1_200_000);
    expect(events[1]).toMatchObject({ t_us: 1_200_000, event_type: "CHECKPOINT", anchor: 2 });
    collector.setAnchor(1, 1_300_000); // 앵커는 줄지 않음
    expect(collector.anchor).toBe(2);
    collector.stop();
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(3);
  });

  it("보임 전환은 바로 CHECKPOINT 로 알림", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fire(document, new Event("visibilitychange"), 1005);
    delete (document as unknown as Record<string, unknown>).visibilityState;
    expect(events).toEqual([expect.objectContaining({ t_us: 5000, event_type: "CHECKPOINT", doc_visible: false })]);
  });
});

describe("휠, 입력, 페이지 이동", () => {
  it("휠 이동량은 소수 둘째 자리까지, delta_mode 이름과 대상", () => {
    fire($("#plain"), new WheelEvent("wheel", { deltaX: 0, deltaY: 120.456, deltaMode: 1, bubbles: true }), 1004);
    expect(events.at(-1)).toEqual({ t_us: 4000, event_type: "WHEEL", wheel_dx: 0, wheel_dy: 120.46, wheel_delta_mode: "line", target: 1 });
  });

  it("INPUT 의 길이 변화는 포커스를 받은 순간의 길이에서 셈(키 없이 값만 바뀐 fill 모양)", () => {
    const input = $("input") as HTMLInputElement;
    input.value = "ab";
    fire(input, new FocusEvent("focusin", { bubbles: true }), 1001);
    input.value = "ab검색어123";
    fire(input, new InputEvent("input", { inputType: "insertFromPaste", bubbles: true }), 1002);
    input.value = "ab검색";
    fire(input, new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }), 1003);
    input.value = "ab검";
    fire(input, new InputEvent("input", { inputType: "formatBold", bubbles: true }), 1004);
    expect(events.filter((e) => e.event_type === "INPUT").map((e) => [e.input_type, e.text_length_delta])).toEqual([
      ["insertFromPaste", 6], ["deleteContentBackward", -4], ["other", -1],
    ]);
  });

  it("시작할 때 첫 화면 NAVIGATION_END 를 보내고, 사전 경로는 이름, 외부 경로는 홀수 번호", () => {
    collector.stop();
    events = [];
    collector = makeCollector();
    collector.start();
    expect(events[0]).toMatchObject({ event_type: "NAVIGATION_END", source: "dom", nav_type: "initial_load" });
    collector.navigation("NAVIGATION_START", "push", "/shop?q=1#top");
    collector.navigation("NAVIGATION_END", "push", "/elsewhere");
    collector.navigation("NAVIGATION_END", "push", "/elsewhere?x");
    expect(events.slice(1).map((e) => e.route)).toEqual(["/shop", expect.any(Number), events[2]!.route]);
    expect(events[2]!.route % 2).toBe(1);
    expect(collector.route).toBe(events[3]!.route);
  });
});

describe("명세 모양", () => {
  it("모은 이벤트를 프레임 하나로 인코드하고 디코드하면 같은 값이 나옴", () => {
    collector.checkpoint(0);
    fire($("#name"), new PointerEvent("pointerdown", { isPrimary: true, clientX: 10, clientY: 20, bubbles: true, pointerType: "touch" }), 1001);
    move(13, 18, 1002, { pointerType: "touch" });
    fire($("#name"), new PointerEvent("pointerup", { isPrimary: true, clientX: 13, clientY: 18, bubbles: true, pointerType: "touch" }), 1003);
    fire(window, new WheelEvent("wheel", { deltaX: 0, deltaY: 120.4, deltaMode: 0 }), 1004);
    fire($("input"), new KeyboardEvent("keydown", { key: "a", repeat: true, bubbles: true }), 1006);
    collector.navigation("NAVIGATION_END", "push", "/shop/cart", "site", 7000);
    expect(types()).toEqual(["CHECKPOINT", "TARGET_INFO", "POINTER_DOWN", "POINTER_MOVE", "POINTER_UP", "WHEEL", "TARGET_INFO", "KEY_DOWN", "NAVIGATION_END"]);

    const withSeq = events.map((e, i) => ({ ...e, event_seq: i + 1 }));
    const frame = { header: { version: 1, msg_type: "DATA", flags: ["HAS_CHECKPOINT"], seq: 1, timestamp_us: 0 }, events: withSeq };
    const decoded = decodeFrame(encodeFrame(frame, dict), dict);
    expect(decoded.events).toEqual(withSeq);
  });
});
