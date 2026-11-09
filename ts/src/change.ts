// CHANGE_ORDER 하나를 사이트가 준 핸들러로 적용하고, 그려진 시각(UI_CHANGE_RENDERED)이나 실패 사유(UI_CHANGE_FAILED)를 보고합니다.
import type { Obj } from "./codec.js";
import { toUs, type EventSink } from "./collector.js";

export type ChangeKind = "reorder" | "price_update" | "inline_error" | "async_reload" | "custom";
export type ChangeFailReason = "target_missing" | "route_mismatch" | "deadline" | "hidden" | "apply_exception" | "session_finishing";

/** CONTROL 0x03 디코드 결과(subtype 제외) */
export interface ChangeOrder {
  anchor: number;
  kind: ChangeKind | number;
  /** dict.targets 의 data-av 값. 사전 밖이면 번호 */
  target_av: string | number | null;
  deadline_ms: number;
  /** null 이면 경로 무관 */
  require_route: string | number | null;
  params: Obj;
}

/** DOM 을 실제로 바꾸는 쪽은 사이트. 비동기 갱신이면 화면을 다 바꾼 뒤 끝나는 Promise 를 돌려줌 */
export type ChangeHandler = (el: Element, params: Obj, order: ChangeOrder) => void | Promise<void>;

/** 현재 앵커를 쥔 쪽(Collector). 이후 CHECKPOINT 에 새 앵커가 실림 */
export interface AnchorHost {
  readonly anchor: number;
  setAnchor(anchor: number, tUs: number): void;
}

export interface ChangeOptions {
  sink: EventSink;
  anchors: AnchorHost;
  /** HELLO 를 보낸 순간의 performance.now() (ms) */
  originMs: number;
  handlers: Partial<Record<ChangeKind, ChangeHandler>>;
  /** 현재 경로(dict.routes 값이나 경로 번호). require_route 비교에 씀 */
  getRoute: () => string | number | null;
  win?: Window;
  raf?: (cb: FrameRequestCallback) => number;
  now?: () => number;
  IntersectionObserver?: typeof IntersectionObserver;
}

export type ChangeResult =
  | { status: "rendered"; tUs: number; applyLagUs: number; visiblePct: number }
  | { status: "failed"; reason: ChangeFailReason; error?: unknown };

export class ChangeApplier {
  private win: Window;
  private raf: (cb: FrameRequestCallback) => number;
  private now: () => number;
  private IO: typeof IntersectionObserver;

  constructor(private o: ChangeOptions) {
    this.win = o.win ?? window;
    const win = this.win;
    this.raf = o.raf ?? ((cb) => win.requestAnimationFrame(cb));
    this.now = o.now ?? (() => win.performance.now());
    this.IO = o.IntersectionObserver ?? (win as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
  }

  /** 받은 즉시 부름. 서버가 지연을 이미 기다렸으므로 바로 적용하고, 보고까지 끝나면 결과로 풀림 */
  apply(order: ChangeOrder): Promise<ChangeResult> {
    const doc = this.win.document;
    const us = (ms: number) => toUs(ms, this.o.originMs);
    const cleanups: (() => void)[] = [];
    let settled = false;
    let applied = false;

    return new Promise<ChangeResult>((resolve) => {
      const finish = (r: ChangeResult) => {
        settled = true;
        for (const c of cleanups) c();
        resolve(r);
      };
      const fail = (reason: ChangeFailReason, error?: unknown) => {
        if (settled) return;
        // 실패는 앵커를 바꾸지 않음. 서버가 이 변화를 노출 안 됨으로 기록함
        this.o.sink.push({ t_us: us(this.now()), event_type: "UI_CHANGE_FAILED", anchor: order.anchor, reason });
        finish(error === undefined ? { status: "failed", reason } : { status: "failed", reason, error });
      };

      // 한 번 DOM 을 바꾼 변화는 늦더라도 RENDERED 로 보고해야 하므로, 기한은 적용 전까지만 봄
      const deadline = setTimeout(() => {
        if (!applied) fail(doc.visibilityState === "hidden" ? "hidden" : "deadline");
      }, order.deadline_ms);
      cleanups.push(() => clearTimeout(deadline));

      const run = async () => {
        if (settled) return;
        if (order.require_route !== null && this.o.getRoute() !== order.require_route) return fail("route_mismatch");
        const el = typeof order.target_av === "string" ? findByAv(doc, order.target_av) : null;
        if (!el) return fail("target_missing");

        applied = true;
        try {
          const handler = typeof order.kind === "string" ? this.o.handlers[order.kind] : undefined;
          if (!handler) throw new Error(`사이트가 ${order.kind} 핸들러를 주지 않음`);
          await handler(el, order.params, order);
        } catch (err) {
          if (settled) return;
          this.o.sink.push({ t_us: us(this.now()), event_type: "COLLECTION_LOSS", reason: "apply_exception", count: 1 });
          return fail("apply_exception", err);
        }
        if (settled) return;
        const tApplied = this.now();

        let tUi: number | undefined;
        let visiblePct: number | undefined;
        const report = () => {
          if (settled || tUi === undefined || visiblePct === undefined) return;
          const tUs = us(tUi);
          const applyLagUs = Math.round((tUi - tApplied) * 1000);
          this.o.sink.push({ t_us: tUs, event_type: "UI_CHANGE_RENDERED", anchor: order.anchor, apply_lag_us: applyLagUs, visible_pct: visiblePct });
          this.o.anchors.setAnchor(order.anchor, tUs);
          finish({ status: "rendered", tUs, applyLagUs, visiblePct });
        };

        const io = new this.IO((entries, obs) => {
          const e = entries.find((x) => x.target === el);
          if (!e) return;
          visiblePct = Math.round(e.intersectionRatio * 100);
          obs.disconnect();
          report();
        });
        io.observe(el);
        cleanups.push(() => io.disconnect());

        // 첫 rAF 는 이번 변화가 그려질 프레임 직전, 두 번째 rAF 는 그 프레임을 그린 다음
        this.raf(() => {
          if (!settled) this.raf((ts) => { if (!settled) { tUi = ts; report(); } });
        });
      };

      if (doc.visibilityState !== "hidden") {
        void run();
        return;
      }
      // 숨겨진 문서는 rAF 가 돌지 않아 그려진 시각을 잴 수 없으므로, 보일 때까지 적용을 미룸
      const onVisible = () => {
        if (doc.visibilityState === "hidden") return;
        doc.removeEventListener("visibilitychange", onVisible);
        void run();
      };
      doc.addEventListener("visibilitychange", onVisible);
      cleanups.push(() => doc.removeEventListener("visibilitychange", onVisible));
    });
  }
}

/** CSS 이스케이프 없이 data-av 값을 그대로 비교함 */
function findByAv(doc: Document, av: string): Element | null {
  for (const el of Array.from(doc.querySelectorAll("[data-av]"))) {
    if (el.getAttribute("data-av") === av) return el;
  }
  return null;
}
