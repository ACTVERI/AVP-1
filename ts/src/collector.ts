// 브라우저 행동을 AVP/1 v0.2 이벤트(codec 디코드 결과와 같은 모양)로 바꿔 sink 에 넘깁니다.
// event_seq 와 프레임 묶기, 프레임 첫 CHECKPOINT 는 sink(Session) 몫입니다.
import type { Dict, Obj } from "./codec.js";

export interface EventSink {
  push(event: Obj): void;
}

export interface CollectorOptions {
  sink: EventSink;
  /** WELCOME 의 dict. data-av 값과 경로를 사전 번호로 바꿀 때 씀 */
  dict: Dict;
  /** HELLO 를 보낸 순간의 performance.now() (ms). 관측 시각 0 */
  originMs: number;
  /** 보임, 포커스, 스크롤을 Session 에 알리는 CHECKPOINT 간격 */
  checkpointMs?: number;
  win?: Window;
  now?: () => number;
}

const POINTER_TYPES = ["mouse", "touch", "pen"];
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const MOD_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);
const FUNCTION_KEYS = new Set(["Escape", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const INPUT_TYPES: Record<string, string> = {
  insertText: "insertText", insertFromPaste: "insertFromPaste", deleteContentBackward: "deleteContentBackward",
  deleteContentForward: "deleteContentForward", insertCompositionText: "insertCompositionText", insertFromDrop: "insertFromDrop",
  historyUndo: "historyUndo", historyRedo: "historyRedo", insertLineBreak: "insertLineBreak",
};
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number"]);
const SENSITIVE_AUTOCOMPLETE = new Set(["one-time-code", "current-password", "new-password"]);

/** 전화번호, 생일, 금액 칸. 숫자와 글자를 나누면 무엇을 쳤는지(자릿수, 형식)가 드러나 키 분류를 하나로 보냄 */
export function isNumericField(el: Element | null): boolean {
  if (!el || typeof el.getAttribute !== "function") return false;
  if (el.getAttribute("inputmode")?.toLowerCase() === "numeric") return true;
  const ac = el.getAttribute("autocomplete")?.toLowerCase() ?? "";
  return ac.startsWith("tel") || ac.startsWith("bday") || ac === "transaction-amount";
}

/** performance.now() 계열 ms 를 HELLO 기준 µs 로 */
export function toUs(ms: number, originMs: number): number {
  return Math.round((ms - originMs) * 1000);
}

/** 명세 key_category 표. 키 값은 여기서만 읽고 버림 */
export function keyCategory(key: string, isComposing = false): string {
  if (key === "Process" || isComposing) return "ime";
  if (MOD_KEYS.has(key)) return "modifier";
  if (key === "Enter") return "enter";
  if (key === "Backspace" || key === "Delete") return "edit";
  if (NAV_KEYS.has(key)) return "navigation";
  if (FUNCTION_KEYS.has(key)) return "function";
  if (key === " ") return "whitespace";
  if (key.length === 1 && key >= "0" && key <= "9") return "digit";
  if (key.length === 1 && /\p{L}/u.test(key)) return "letter";
  if (key.length === 1) return "symbol";
  return "other";
}

/** 비밀번호, 카드, 일회용 코드 칸. 이 칸의 키와 입력은 보내지 않음 */
export function isSensitive(el: Element | null): boolean {
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("[data-av-ignore]")) return true;
  const type = el.getAttribute("type")?.toLowerCase();
  if (el.tagName === "INPUT" && type === "password") return true;
  const ac = el.getAttribute("autocomplete")?.toLowerCase() ?? "";
  return ac.startsWith("cc-") || SENSITIVE_AUTOCOMPLETE.has(ac);
}

/** 명세 role 값 표. 태그, type, ARIA role 로 정함 */
export function roleOf(el: Element): string {
  if (isSensitive(el)) return "sensitive_input";
  const aria = el.getAttribute("role");
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || aria === "button") return "button";
  if ((tag === "a" && el.hasAttribute("href")) || aria === "link") return "link";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) return "text_input";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "other";
  }
  const byTag: Record<string, string> = {
    select: "select", textarea: "textarea", img: "image", li: "list_item", label: "label", form: "form", dialog: "dialog",
    div: "container", section: "container", ul: "container", ol: "container", main: "container", article: "container",
  };
  if (byTag[tag]) return byTag[tag]!;
  if (aria === "dialog") return "dialog";
  return "other";
}

export class Collector {
  private o: Required<Omit<CollectorOptions, "win">> & { win: Window };
  private _anchor = 0;
  private pos: { x: number; y: number } | null = null;
  private pointerType = "mouse";
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners: [EventTarget, string, EventListener][] = [];
  private running = false;
  private targets = new WeakMap<Element, number>();
  private nextTarget = 1;
  private lengths = new WeakMap<Element, number>();
  /** 한 번 민감했던 칸. 비밀번호 보기처럼 type 을 바꿔도 계속 민감으로 봄 */
  private wasSensitive = new WeakSet<Element>();
  private extRoutes = new Map<string, number>();
  private _route: string | number | null = null;

  constructor(opts: CollectorOptions) {
    const win = opts.win ?? window;
    this.o = { checkpointMs: 1000, now: () => win.performance.now(), ...opts, win };
  }

  get anchor(): number {
    return this._anchor;
  }

  /** 마지막 NAVIGATION_END 의 경로. CHANGE_ORDER 의 require_route 와 비교함 */
  get route(): string | number | null {
    return this._route;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { win } = this.o;
    const doc = win.document;
    this.on(doc, "pointermove", (e) => this.onMove(e as PointerEvent));
    this.on(doc, "pointerdown", (e) => this.onButton(e as PointerEvent, "POINTER_DOWN"));
    this.on(doc, "pointerup", (e) => this.onButton(e as PointerEvent, "POINTER_UP"));
    this.on(win, "wheel", (e) => this.onWheel(e as WheelEvent));
    this.on(doc, "keydown", (e) => this.onKey(e as KeyboardEvent, "KEY_DOWN"));
    this.on(doc, "keyup", (e) => this.onKey(e as KeyboardEvent, "KEY_UP"));
    this.on(doc, "input", (e) => this.onInput(e as InputEvent));
    this.on(doc, "focusin", (e) => this.onFocus(e));
    this.on(doc, "visibilitychange", (e) => this.checkpoint(this.us(e.timeStamp)));
    this.on(win, "resize", (e) => this.emit({
      t_us: this.us(e.timeStamp), event_type: "VIEWPORT_CHANGE", viewport_width: win.innerWidth, viewport_height: win.innerHeight,
      dpr_milli: Math.round((win.devicePixelRatio || 1) * 1000),
    }));
    this.timer = setInterval(() => this.checkpoint(), this.o.checkpointMs);
    // 서버는 NAVIGATION_END 경로로 화면 변화를 계획하므로, 이미 열려 있는 첫 화면을 알림
    this.navigation("NAVIGATION_END", "initial_load", win.location?.pathname ?? "/", "dom");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn, true);
    this.listeners = [];
    clearInterval(this.timer);
  }

  /** 현재 포인터 위치, 보임과 포커스, scrollY, 앵커. Session 이 프레임 첫 CHECKPOINT 를 이 값으로 채움 */
  checkpoint(tUs?: number): void {
    const { win } = this.o;
    const doc = win.document;
    this.emit({
      t_us: tUs ?? this.us(this.o.now()), event_type: "CHECKPOINT", pointer_known: !!this.pos,
      doc_visible: doc.visibilityState !== "hidden", window_focused: doc.hasFocus(), pointer_type: this.pointerType,
      x: this.pos?.x ?? 0, y: this.pos?.y ?? 0, scroll_y: Math.max(0, Math.round(win.scrollY)), anchor: this._anchor,
    });
  }

  /** 변화가 그려진 뒤 부름. 이후 CHECKPOINT 에 새 앵커가 실림 */
  setAnchor(anchor: number, tUs: number): void {
    this._anchor = Math.max(this._anchor, anchor);
    this.checkpoint(tUs);
  }

  /** 페이지 이동 알림. 사전 경로면 그 이름, 외부 사이트면 출처와 경로 조합마다 매긴 홀수 번호 */
  navigation(type: "NAVIGATION_START" | "NAVIGATION_END", navType: string, path: string, source = "site", tUs?: number): void {
    const route = this.routeOf(path);
    if (type === "NAVIGATION_END") this._route = route;
    this.emit({ t_us: tUs ?? this.us(this.o.now()), event_type: type, source, nav_type: navType, route });
  }

  private routeOf(path: string): string | number | null {
    const clean = path.split(/[?#]/)[0]!;
    if ((this.o.dict.routes ?? []).indexOf(clean) > 0) return clean;
    const key = `${this.o.win.location?.origin ?? ""}${clean}`;
    if (!this.extRoutes.has(key)) this.extRoutes.set(key, this.extRoutes.size + 1);
    return (this.extRoutes.get(key)! << 1) | 1;
  }

  private on(t: EventTarget, type: string, fn: EventListener): void {
    // 페이지가 stopPropagation 해도 놓치지 않게 capture 로 받음
    t.addEventListener(type, fn, { capture: true, passive: true });
    this.listeners.push([t, type, fn]);
  }

  private us(ms: number): number {
    return toUs(ms, this.o.originMs);
  }

  private emit(e: Obj): void {
    this.o.sink.push(e);
  }

  /** 처음 쓰는 요소면 같은 시각으로 TARGET_INFO 를 먼저 내보내고 번호를 돌려줌 */
  private target(t: EventTarget | null, tUs: number): number | null {
    if (!t || typeof (t as Element).getBoundingClientRect !== "function") return null;
    const el = t as Element;
    let n = this.targets.get(el);
    if (n !== undefined) return n;
    n = this.nextTarget++;
    this.targets.set(el, n);
    const av = el.closest("[data-av]")?.getAttribute("data-av");
    const r = el.getBoundingClientRect();
    this.emit({
      t_us: tUs, event_type: "TARGET_INFO", target: n, target_role: roleOf(el),
      av_key: av && (this.o.dict.targets ?? []).indexOf(av) > 0 ? av : null,
      target_bbox: [Math.round(r.left), Math.round(r.top), Math.max(0, Math.round(r.width)), Math.max(0, Math.round(r.height))],
    });
    return n;
  }

  private onMove(e: PointerEvent): void {
    if (e.isPrimary === false) return;
    const x = Math.round(e.clientX), y = Math.round(e.clientY);
    const tUs = this.us(e.timeStamp);
    if (POINTER_TYPES.includes(e.pointerType)) this.pointerType = e.pointerType;
    if (!this.pos) {
      // 위치를 처음 알게 된 순간은 이동 대신 그 위치를 담은 CHECKPOINT 로 기준을 세움
      this.pos = { x, y };
      this.checkpoint(tUs);
      return;
    }
    const dx = x - this.pos.x, dy = y - this.pos.y;
    this.pos = { x, y };
    // x, y 는 codec 인코드가 무시함. Session 이 프레임 첫 CHECKPOINT 기준으로 dx, dy 를 다시 셈
    this.emit({ t_us: tUs, event_type: "POINTER_MOVE", dx, dy, x, y });
  }

  private onButton(e: PointerEvent, type: "POINTER_DOWN" | "POINTER_UP"): void {
    if (e.isPrimary === false) return;
    const tUs = this.us(e.timeStamp);
    // 뷰포트 밖 좌표는 음수일 수 있어 svar 로 그대로 보냄
    const x = Math.round(e.clientX), y = Math.round(e.clientY);
    this.pos = { x, y };
    const pointerType = POINTER_TYPES.includes(e.pointerType) ? e.pointerType : "unknown";
    if (pointerType !== "unknown") this.pointerType = pointerType;
    const target = this.target(e.target, tUs);
    this.emit({ t_us: tUs, event_type: type, x, y, button: Math.max(0, e.button), pointer_type: pointerType, trusted: e.isTrusted === true, target });
  }

  private onWheel(e: WheelEvent): void {
    const tUs = this.us(e.timeStamp);
    const target = this.target(e.target, tUs);
    const mode = [0, 1, 2].includes(e.deltaMode) ? e.deltaMode : 0;
    this.emit({
      t_us: tUs, event_type: "WHEEL", wheel_dx: Math.round(e.deltaX * 100) / 100, wheel_dy: Math.round(e.deltaY * 100) / 100,
      wheel_delta_mode: ["pixel", "line", "page"][mode], target,
    });
  }

  /** 이벤트 대상이나 포커스 요소 가운데 하나라도 민감하면 참 */
  private sensitive(el: Element | null): boolean {
    for (const x of [el, this.o.win.document.activeElement]) {
      if (!x) continue;
      if (this.wasSensitive.has(x)) return true;
      if (isSensitive(x)) {
        this.wasSensitive.add(x);
        return true;
      }
    }
    return false;
  }

  private onKey(e: KeyboardEvent, type: "KEY_DOWN" | "KEY_UP"): void {
    const el = e.target as Element | null;
    if (this.sensitive(el)) return;
    const tUs = this.us(e.timeStamp);
    const target = this.target(el, tUs);
    const mods = [e.shiftKey && "shift", e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "meta"].filter(Boolean);
    this.emit({
      t_us: tUs, event_type: type, key_category: isNumericField(el) ? "other" : keyCategory(e.key, e.isComposing), trusted: e.isTrusted === true,
      repeat: e.repeat, is_composing: e.isComposing === true, modifier_flags: mods, target,
    });
  }

  private valueLength(el: Element): number | undefined {
    const v = (el as HTMLInputElement).value;
    if (typeof v === "string") return v.length;
    if ((el as HTMLElement).isContentEditable) return (el.textContent ?? "").length;
    return undefined;
  }

  private onFocus(e: Event): void {
    const el = e.target as Element | null;
    if (this.sensitive(el)) return;
    // 처음 보는 칸의 직전 길이는 포커스를 받은 순간의 길이. 글자는 읽지 않고 길이만 씀
    if (el && !this.lengths.has(el)) {
      const n = this.valueLength(el);
      if (n !== undefined) this.lengths.set(el, n);
    }
  }

  private onInput(e: InputEvent): void {
    const el = e.target as Element | null;
    // 민감 칸은 길이 변화만으로도 비밀번호 길이가 드러나 INPUT 도 보내지 않음
    if (!el || this.sensitive(el)) return;
    const n = this.valueLength(el);
    if (n === undefined) return;
    const before = this.lengths.get(el) ?? 0;
    this.lengths.set(el, n);
    const tUs = this.us(e.timeStamp);
    const target = this.target(el, tUs);
    this.emit({
      t_us: tUs, event_type: "INPUT", source: "dom", target, input_type: INPUT_TYPES[e.inputType] ?? "other",
      text_length_delta: n - before, trusted: e.isTrusted === true,
    });
  }
}
