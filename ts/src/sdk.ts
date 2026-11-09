// 데모 페이지가 부르는 입구. 수집기, Session, WebSocket 을 잇기만 함
import type { Obj } from "./codec.js";
import { Session, type ChangeReport, type Clock, type SessionEnd, type TapRecord } from "./session.js";
import { wsTransport, type WebSocketLike } from "./transport-ws.js";

export const SDK_VERSION = "stlab/0.3.2";

export interface ActveriOptions {
  /** 공개 앱 키. URL 의 k 와 HELLO client_key 에 같은 값이 실림 */
  clientKey: string;
  /** wss://<호스트>/avp/1/ws */
  endpoint: string;
  missionId: string;
  missionKind?: "external_site" | "custom_mission" | "captcha";
  /** 비트0 captcha_enabled, 비트2 change_orders_supported. 기본 1(판단 요청). 판단을 끌지는 서버 설정이 정하고 이 비트는 요청일 뿐 */
  runFlags?: number;
  clientKind?: "electron_lab" | "browser_sdk";
  handlers?: {
    /** CHANGE_ORDER 를 받으면 부름. 적용 결과는 report 로 돌려줌 */
    onChangeOrder?: (order: Obj, report: (r: ChangeReport) => void) => void;
    /** INFERENCE_RESULT, STATE, CAPTCHA 중계 등 서버 프레임 */
    onServerMessage?: (frame: Obj) => void;
    onTap?: (r: TapRecord) => void;
  };
  /** 수집기를 붙이는 자리. sink 로 이벤트를 넘기고, 떼어 낼 함수를 돌려줌 */
  collector?: (sink: (event: Obj) => void, clock: Clock, session: Session) => (() => void) | void;
  WebSocketImpl?: new (url: string, protocol: string) => WebSocketLike;
  clock?: Clock;
  /** 세션 0점의 유닉스 µs. 안 주면 지금 */
  t0UnixUs?: number;
}

export interface Actveri {
  session: Session;
  push(event: Obj): void;
  finish(reason?: string): Promise<SessionEnd>;
  stop(): void;
}

export function defaultClock(): Clock {
  const t0 = performance.now();
  return {
    now: () => Math.round((performance.now() - t0) * 1000),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
}

function helloFields(o: ActveriOptions): Obj {
  const w = typeof window !== "undefined" ? window : undefined;
  const mm = (q: string) => !!w?.matchMedia?.(q).matches;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const touch = Math.min(255, nav?.maxTouchPoints ?? 0);
  const chromium = /Chrom(e|ium)\/(\d+)/.exec(nav?.userAgent ?? "");
  const webdriver = nav?.webdriver;
  const doc = typeof document !== "undefined" ? document : undefined;
  return {
    proto_minor: 3,
    caps: 0,
    client_kind: o.clientKind ?? "browser_sdk",
    mission_kind: o.missionKind ?? "custom_mission",
    run_flags: o.runFlags ?? 1,
    sdk_version: SDK_VERSION,
    client_key: o.clientKey,
    mission_id: o.missionId,
    t0_unix_us: o.t0UnixUs ?? Math.round((performance.timeOrigin + performance.now()) * 1000),
    viewport_width: w?.innerWidth ?? 0,
    viewport_height: w?.innerHeight ?? 0,
    dpr_milli: Math.round((w?.devicePixelRatio ?? 1) * 1000),
    input_caps: (mm("(any-pointer: fine)") ? 1 : 0) | (mm("(any-pointer: coarse)") ? 2 : 0) | (mm("(any-hover: hover)") ? 4 : 0) | (touch > 0 ? 8 : 0),
    max_touch_points: touch,
    browser_family: chromium ? 1 : 0,
    browser_major: chromium ? Number(chromium[2]) : 0,
    sampling_policy: 0,
    env_flags: (webdriver === true ? 1 : 0) | (webdriver === undefined ? 2 : 0) | (doc?.visibilityState !== "hidden" ? 4 : 0) | (doc?.hasFocus?.() ? 8 : 0),
  };
}

export function createActveri(o: ActveriOptions): Actveri {
  const clock = o.clock ?? defaultClock();
  const WS = o.WebSocketImpl ?? (globalThis.WebSocket as unknown as ActveriOptions["WebSocketImpl"]);
  if (!WS) throw new Error("WebSocket 이 없는 환경입니다. WebSocketImpl 을 넘깁니다");
  const url = new URL(o.endpoint);
  url.searchParams.set("k", o.clientKey);
  const ws = new WS(url.toString(), "avp.1");

  const session = new Session({ transport: wsTransport(ws), clock, hello: helloFields(o) });
  session.onChangeOrder((order) => o.handlers?.onChangeOrder?.(order, (r) => session.reportChange(r)));
  if (o.handlers?.onServerMessage) session.onServerMessage(o.handlers.onServerMessage);
  if (o.handlers?.onTap) session.onTap(o.handlers.onTap);
  const detach = o.collector?.((e) => session.push(e), clock, session);
  session.start();

  return {
    session,
    push: (e) => session.push(e),
    finish: (reason) => session.finish(reason),
    stop() {
      detach?.();
      ws.close(1000);
    },
  };
}
