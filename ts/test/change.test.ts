// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeApplier, type ChangeHandler, type ChangeOrder } from "../src/change.js";
import { Collector } from "../src/collector.js";
import { decodeFrame, encodeFrame, type Dict, type Obj } from "../src/codec.js";

const dict: Dict = { targets: ["", "search_box", "result_list", "cart_button"], routes: ["", "/shop", "/shop/cart"] };

function manualRaf() {
  let queue: FrameRequestCallback[] = [];
  return {
    raf: (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; },
    tick(ts: number) { const q = queue; queue = []; for (const cb of q) cb(ts); },
    get pending() { return queue.length; },
  };
}

let ratio = 1;
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, intersectionRatio: ratio, isIntersecting: ratio > 0 } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

let events: Obj[];
let frames: ReturnType<typeof manualRaf>;
let collector: Collector;
let route: string | number | null;
let handler: ReturnType<typeof vi.fn<ChangeHandler>>;
let applier: ChangeApplier;
const now = () => Date.now();

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
}

function order(over: Partial<ChangeOrder> = {}): ChangeOrder {
  return {
    anchor: 1, kind: "price_update", target_av: "result_list", params: { item: "p2", price: 31900 },
    deadline_ms: 5000, require_route: "/shop", ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  document.body.innerHTML = `<ul data-av="result_list"><li>p1</li><li>p2</li></ul>`;
  setHidden(false);
  events = [];
  ratio = 1;
  route = "/shop";
  frames = manualRaf();
  const sink = { push: (e: Obj) => events.push(e) };
  collector = new Collector({ sink, dict, originMs: 0, checkpointMs: 1e9, now });
  handler = vi.fn<ChangeHandler>();
  applier = new ChangeApplier({
    sink, anchors: collector, originMs: 0, getRoute: () => route, now, raf: frames.raf,
    IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver,
    handlers: { reorder: handler, price_update: handler, inline_error: handler, async_reload: handler },
  });
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.useRealTimers();
});

const uiChanges = () => events.filter((e) => String(e.event_type).startsWith("UI_CHANGE"));

describe("그려진 시각 보고", () => {
  it("받은 즉시 사이트 핸들러로 적용하고, 이중 rAF 두 번째 콜백 시각을 t_ui 로 보고한 뒤 앵커를 바꿈", async () => {
    ratio = 0.504;
    const o = order();
    await vi.advanceTimersByTimeAsync(100);
    const done = applier.apply(o);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledWith(document.querySelector("ul"), o.params, o);

    frames.tick(116.5);
    await vi.advanceTimersByTimeAsync(0);
    expect(uiChanges()).toHaveLength(0); // rAF 한 번으로는 아직 그려졌다고 보지 않음
    expect(collector.anchor).toBe(0);

    frames.tick(133.25);
    await expect(done).resolves.toEqual({ status: "rendered", tUs: 133250, applyLagUs: 33250, visiblePct: 50 });
    expect(events).toEqual([
      { t_us: 133250, event_type: "UI_CHANGE_RENDERED", anchor: 1, apply_lag_us: 33250, visible_pct: 50 },
      expect.objectContaining({ t_us: 133250, event_type: "CHECKPOINT", anchor: 1 }),
    ]);
    expect(collector.anchor).toBe(1);

    const withSeq = [events[1], events[0]].map((e, i) => ({ ...e, event_seq: i + 1 }));
    const frame = { header: { version: 1, msg_type: "DATA", flags: ["HAS_CHECKPOINT"], seq: 1, timestamp_us: 133250 }, events: withSeq };
    expect(decodeFrame(encodeFrame(frame, dict), dict).events[1]).toMatchObject({ applied_at_us: 100000 });
  });

  it("비동기 핸들러는 끝난 시각을 tApplied 로 씀", async () => {
    handler.mockImplementation(() => new Promise((r) => setTimeout(r, 400)));
    const done = applier.apply(order({ kind: "async_reload", params: { region: "result_list", spinner_ms: 400 } }));
    await vi.advanceTimersByTimeAsync(400);
    frames.tick(410);
    frames.tick(420);
    await expect(done).resolves.toMatchObject({ status: "rendered", tUs: 420000, applyLagUs: 20000 });
  });

  it("숨겨진 문서에서는 적용을 미루고, 다시 보이면 그때 적용해 그려진 시각을 잼", async () => {
    setHidden(true);
    const done = applier.apply(order());
    await vi.advanceTimersByTimeAsync(300);
    expect(handler).not.toHaveBeenCalled();
    expect(frames.pending).toBe(0);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    frames.tick(300.5);
    frames.tick(316.5);
    await expect(done).resolves.toMatchObject({ status: "rendered", tUs: 316500, applyLagUs: 16500 });
    expect(collector.anchor).toBe(1);
  });

  it("DOM 을 바꾼 뒤 기한이 지나도 실패로 보고하지 않고 그려지면 RENDERED", async () => {
    handler.mockImplementation(() => new Promise((r) => setTimeout(r, 600)));
    const done = applier.apply(order({ deadline_ms: 500 }));
    await vi.advanceTimersByTimeAsync(600);
    frames.tick(610);
    frames.tick(626);
    await expect(done).resolves.toMatchObject({ status: "rendered", tUs: 626000 });
    expect(events.map((e) => e.event_type)).toEqual(["UI_CHANGE_RENDERED", "CHECKPOINT"]);
  });
});

describe("적용하지 못한 경우", () => {
  const failed = (reason: string, tUs: number) => ({ t_us: tUs, event_type: "UI_CHANGE_FAILED", anchor: 1, reason });

  it("target_missing: 대상 data-av 요소가 없으면 핸들러를 부르지 않음", async () => {
    await vi.advanceTimersByTimeAsync(100);
    const done = applier.apply(order({ target_av: "cart_button" }));
    await expect(done).resolves.toEqual({ status: "failed", reason: "target_missing" });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([failed("target_missing", 100000)]);
    expect(collector.anchor).toBe(0);
  });

  it("route_mismatch: 현재 경로가 require_route 와 다르면 적용하지 않음", async () => {
    route = "/shop/cart";
    const done = applier.apply(order());
    await expect(done).resolves.toEqual({ status: "failed", reason: "route_mismatch" });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([failed("route_mismatch", 0)]);
  });

  it("require_route 가 null 이면 경로를 보지 않음", async () => {
    route = "/anywhere";
    const done = applier.apply(order({ require_route: null }));
    await vi.advanceTimersByTimeAsync(0);
    frames.tick(1);
    frames.tick(2);
    await expect(done).resolves.toMatchObject({ status: "rendered" });
  });

  it("deadline: 보이는데 기한 안에 적용하지 못하면 실패, 늦은 rAF 는 무시", async () => {
    // 숨겨진 채 받아 적용을 미뤘고, 기한 직전 보이게 됐지만 visibilitychange 가 오기 전에 기한이 지난 경우
    setHidden(true);
    const done = applier.apply(order({ deadline_ms: 500 }));
    setHidden(false);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ status: "failed", reason: "deadline" });
    frames.tick(600);
    frames.tick(616);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([failed("deadline", 500000)]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hidden: 숨겨진 채로 기한을 넘기면 적용하지 않고 실패", async () => {
    setHidden(true);
    const done = applier.apply(order({ deadline_ms: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toEqual({ status: "failed", reason: "hidden" });
    expect(handler).not.toHaveBeenCalled();
    expect(events).toEqual([failed("hidden", 500000)]);
    expect(collector.anchor).toBe(0);
  });

  it("apply_exception: 핸들러가 던지면 COLLECTION_LOSS 사유 5와 UI_CHANGE_FAILED 를 함께 보냄", async () => {
    handler.mockImplementation(() => { throw new Error("사이트 오류"); });
    const done = applier.apply(order());
    await expect(done).resolves.toEqual({ status: "failed", reason: "apply_exception", error: new Error("사이트 오류") });
    expect(events).toEqual([
      { t_us: 0, event_type: "COLLECTION_LOSS", reason: "apply_exception", count: 1 },
      failed("apply_exception", 0),
    ]);
    expect(collector.anchor).toBe(0);
  });

  it("apply_exception: 사이트가 그 종류의 핸들러를 주지 않았을 때도 같음", async () => {
    const a = new ChangeApplier({
      sink: { push: (e) => events.push(e) }, anchors: collector, originMs: 0, getRoute: () => route, now, raf: frames.raf,
      IntersectionObserver: FakeIO as unknown as typeof IntersectionObserver, handlers: {},
    });
    const done = a.apply(order({ kind: "inline_error", params: { field: "qty", code: "E1" } }));
    await expect(done).resolves.toMatchObject({ status: "failed", reason: "apply_exception", error: expect.any(Error) });
    expect(events.map((e) => e.event_type)).toEqual(["COLLECTION_LOSS", "UI_CHANGE_FAILED"]);
  });
});
