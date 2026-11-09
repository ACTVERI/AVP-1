// AVP/1 v0.3.1 Protocol Client 상태 기계. 네트워크와 시계는 밖에서 받아 Node 에서도 돌아감.
import {
  AvpError, buildFrame, CLOSE_CODES, concat, crc32, decodeFrame, encodeEvent, encodeFrame, FLAG, fromHex, LIMITS, MSG, sha256, toHex,
  type Dict, type Obj,
} from "./codec.js";

export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (code: number) => void): void;
  close(code?: number): void;
}

export interface Clock {
  /** 세션 0점 기준 µs */
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type SessionState = "connecting" | "open" | "finishing" | "ended";

export type ChangeReport =
  | { anchor: number; ok: true; tUiUs: number; applyLagUs: number; visiblePct: number }
  | { anchor: number; ok: false; reason: string; tUs: number };

/** 끝난 이유는 STATE(ENDED) 의 reason, 또는 disconnected, timeout, error */
export interface SessionEnd {
  reason: string;
  lastResult?: Obj;
}

export interface CaptchaAsset {
  index: number;
  name: string;
  type: string;
  /** 크기와 SHA-256 을 확인한 에셋 원본 */
  bytes: Uint8Array;
}

/** 조각을 다 모으고 확인한 챌린지. 화면은 이것만 받아 그림 */
export interface CaptchaChallenge {
  challengeId: string;
  challengeNo: number;
  windowId: number;
  reason: string | number;
  ttlMs: number;
  meta: Obj;
  assets: CaptchaAsset[];
  /** FINISH 뒤에 받은 챌린지(FINAL 결과로 발동). 답을 보내면 세션이 곧 끝나 CAPTCHA_VIEW closed 를 보내지 않음 */
  final: boolean;
}

/** 보호 행동 하나의 판단 결과. allowed 는 그 행동의 event_seq 를 가리키는 action_allowed STATE 를 받았을 때만 참 */
export interface ActionVerdict {
  allowed: boolean;
  eventSeq: number;
  state: string | number;
  reason: string | number;
  /** 1회용 행동 토큰(hex 32자). 사이트 백엔드나 Electron main 이 서버에 확인해야 행동 완료로 인정됨 */
  token?: string;
}

/** 명세 'Protocol Client 탭'. 보내고 받은 바이트의 복사본과 디코드 결과 */
export interface TapRecord {
  dir: "tx" | "rx";
  bytes: Uint8Array;
  byteLength: number;
  sessionUs: number;
  msgType: number;
  seq: number;
  firstEventSeq?: number;
  lastEventSeq?: number;
  windowId?: number;
  decoded?: unknown;
  ackCrcMatch?: boolean;
}

export interface SessionOptions {
  transport: Transport;
  clock: Clock;
  /** HELLO 필드(subtype 제외) */
  hello: Obj;
  /** ACK 못 받은 프레임의 바이트 상한. 명세 기본값 1MiB */
  maxUnackedBytes?: number;
}

/** 서버가 모으지 않고 바로 ACK 하도록 ACK_REQUESTED 를 켜는 이벤트 */
const IMMEDIATE = new Set(["POINTER_DOWN", "POINTER_UP", "KEY_DOWN", "KEY_UP", "INPUT", "NAVIGATION_START", "NAVIGATION_END", "UI_CHANGE_RENDERED", "UI_CHANGE_FAILED", "PROTECTED_ACTION"]);
/** 클라이언트가 받으면 안 되는 CONTROL */
const CLIENT_ONLY = new Set(["HELLO", "FINISH", "CAPTCHA_ANSWER", "SCORE_REQUEST", "RUN_LABEL"]);
const FINISH_WAIT_US = 3_000_000;
// FINISH 뒤에도 서버 프레임이 오는 한 기다리지만, 열린 챌린지의 ttl_ms(없으면 가안 60초) + 20초 안에 ENDED 가 없으면 끝냄
const DEFAULT_TTL_MS = 60_000;
const FINISH_GRACE_MS = 20_000;
// WELCOME 값을 그대로 믿지 않고 이 범위로 자름. 0 이나 아주 큰 값이 오면 묶음 타이머나 프레임 나누기가 멈추거나 넘침
const WELCOME_RANGE: Record<string, [number, number]> = {
  flush_ms: [10, 1000],
  keepalive_ms: [100, 60_000],
  max_payload_bytes: [4096, LIMITS.maxPayload],
  max_events_per_frame: [2, LIMITS.maxEventsPerFrame],
  max_unacked_frames: [1, 64],
};
// 명세 ASSET_CHUNK 한도(가안)
const CAPTCHA = { chunkBytes: 32768, chunksPerAsset: 16, assets: 8, totalBytes: 524288, assetWaitUs: 10_000_000 };
// 스크립트가 들어갈 수 있는 SVG, HTML 은 받지 않음
const CAPTCHA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// 명세 CAPTCHA_ANSWER answer.trajectory 표. 밖의 키(좌표, 시각 원본, 클라이언트 판정)는 보내지 않음
const TRAJECTORY_KEYS = ["v", "n", "durationMs", "pathLengthPx", "straightness", "speedMean", "speedCV", "pauseCount", "subMovements", "jitterPx", "maxJumpPx", "dtCV", "speedProfile"];
const TRAJECTORY_MAX_BYTES = 1024;
// 명세 CAPTCHA_ANSWER: 문제 종류마다 받는 답 키. 표에 없는 키(입력 글자, 클라이언트 판정)는 보내지 않음
const ANSWER_KEYS: Record<string, string[]> = { guide_sol: ["reached"], drag_order: ["order"] };
const ANSWER_RESERVED = ["elapsed_ms", "trajectory"];

interface Pending { seq: number; bytes: Uint8Array }
interface AssetParts { size: number; sha: string; count: number; parts: Map<number, Uint8Array> }
interface OpenCaptcha {
  c: Obj;
  final: boolean;
  assets: Map<number, AssetParts>;
  assetDeadlineUs: number;
  ttlDeadlineUs: number;
  delivered: boolean;
  answered: boolean;
}
interface OutFrame { events: Uint8Array[]; flags: number; startUs: number; firstSeq: number; bytes: number }

export class Session {
  state: SessionState = "connecting";
  sessionId?: string;
  dict?: Dict;
  schema?: Obj;
  lastResult?: Obj;
  /** STATE(BLOCKED) 를 받았으면 그 사유와 판단 윈도우 */
  blocked?: { reason: string | number; windowId: number };
  config = { flush_ms: 50, keepalive_ms: 15000, max_payload_bytes: LIMITS.maxPayload, max_events_per_frame: LIMITS.maxEventsPerFrame, max_unacked_frames: 64 };

  private buffer: Obj[] = [];
  private pending: Pending[] = [];
  private nextSeq = 1;
  private lastDataSeq = 0;
  private nextEventSeq = 1;
  private lossCount = 0;
  /** 서버 번호 공간에서 처리한 마지막 번호 */
  private serverSeq = 0;
  private anchor = 0;
  private pointer?: { x: number; y: number };
  private env = { visible: true, focused: true, scrollY: 0, pointerType: "mouse" };
  private lastSendUs = 0;
  private timer?: unknown;
  private finishSent = false;
  private finishAtUs = 0;
  /** FINISH 뒤 서버 프레임을 하나라도 받았는지. 받았으면 3초 무응답 종료를 하지 않음 */
  private rxSinceFinish = false;
  private captcha?: OpenCaptcha;
  private lastChallengeNo = 0;
  private captchaCbs: ((c: CaptchaChallenge) => void)[] = [];
  /** 결과를 기다리는 보호 행동. event_seq 로 짝지음 */
  private actionWaiters = new Map<number, (v: ActionVerdict) => void>();
  private end?: SessionEnd;
  private endWaiters: ((e: SessionEnd) => void)[] = [];
  private changeCbs: ((order: Obj) => void)[] = [];
  private messageCbs: ((frame: Obj) => void)[] = [];
  private tapCbs: ((r: TapRecord) => void)[] = [];
  private readonly maxUnackedBytes: number;

  constructor(private opts: SessionOptions) {
    this.maxUnackedBytes = opts.maxUnackedBytes ?? 1 << 20;
    opts.transport.onMessage((b) => this.onMessage(b));
    opts.transport.onClose(() => this.finishWith({ reason: "disconnected" }));
  }

  start(): void {
    this.send(encodeFrame({ header: header("CONTROL", 0, this.now()), control: { subtype: "HELLO", ...this.opts.hello } }));
  }

  /** 수집기가 넘기는 이벤트. 디코드 결과와 같은 모양이고, POINTER_MOVE 는 절대 x, y 를 줌. event_seq 는 여기서 매김 */
  push(event: Obj): void {
    // FINISH 뒤에는 챌린지가 열려 있는 동안만 보냄(그 밖은 서버가 E_STATE)
    if (this.state === "ended" || (this.finishSent && !this.challengeOpen())) return;
    this.buffer.push(event);
    if (IMMEDIATE.has(event.event_type)) this.flush();
  }

  /** 보호 행동(구매, 송금, 제출)을 알리고 그 행동의 판단 결과를 기다림. 앱은 allowed 일 때만 진행함 */
  protectedAction(actionKind: string | number, target: number | null = null, tUs = this.now()): Promise<ActionVerdict> {
    return new Promise((resolve) => {
      if (this.state === "ended" || this.finishSent) {
        resolve({ allowed: false, eventSeq: 0, state: this.state, reason: this.end?.reason ?? "finishing" });
        return;
      }
      this.push({ t_us: tUs, event_type: "PROTECTED_ACTION", action_kind: actionKind, target, _verdict: resolve });
    });
  }

  /** CHANGE_ORDER 디코드 결과(subtype 제외)를 받음 */
  onChangeOrder(cb: (order: Obj) => void): () => void {
    return on(this.changeCbs, cb);
  }

  /** 서버가 보낸 모든 프레임의 디코드 결과(INFERENCE_RESULT, STATE, CAPTCHA 중계 등) */
  onServerMessage(cb: (frame: Obj) => void): () => void {
    return on(this.messageCbs, cb);
  }

  onTap(cb: (r: TapRecord) => void): () => void {
    return on(this.tapCbs, cb);
  }

  /** 에셋 조각을 다 모아 크기와 SHA-256 을 확인한 챌린지. 확인에 실패하면 부르지 않고 asset_error 를 보냄 */
  onCaptcha(cb: (c: CaptchaChallenge) => void): () => void {
    return on(this.captchaCbs, cb);
  }

  /** 챌린지 화면을 그렸거나(이중 rAF 시각) 닫은 순간. 위치와 크기는 앱 창 기준 CSS 픽셀 */
  captchaView(phase: "shown" | "closed", rect: { x: number; y: number; w: number; h: number }, tUs = this.now()): void {
    this.push({ t_us: tUs, event_type: "CAPTCHA_VIEW", phase, challenge_no: this.lastChallengeNo, view_x: rect.x, view_y: rect.y, view_w: rect.w, view_h: rect.h });
  }

  /** 답을 보냄. trajectory 는 명세 표의 키만 남기고 1,024B 를 넘으면 뺌 */
  answerCaptcha(answer: Obj): void {
    // 표에 없는 종류는 받을 키를 모르므로 종류별 키를 하나도 보내지 않음(서버도 버림)
    const allowed = ANSWER_KEYS[String(this.captcha?.c.meta?.kind)] ?? [];
    const out: Obj = {};
    for (const [k, v] of Object.entries(answer)) if (ANSWER_RESERVED.includes(k) || allowed.includes(k)) out[k] = v;
    if (out.trajectory && typeof out.trajectory === "object") {
      const t: Obj = {};
      for (const k of TRAJECTORY_KEYS) if (k in out.trajectory) t[k] = out.trajectory[k];
      out.trajectory = t;
      if (new TextEncoder().encode(JSON.stringify(t)).length > TRAJECTORY_MAX_BYTES) delete out.trajectory;
    }
    this.sendAnswer("answered", out);
  }

  reportChange(r: ChangeReport): void {
    if (r.ok) {
      this.push({ t_us: r.tUiUs, event_type: "UI_CHANGE_RENDERED", anchor: r.anchor, apply_lag_us: r.applyLagUs, visible_pct: r.visiblePct });
      // 현재 앵커는 그려졌다고 보고한 가장 큰 번호이고 줄지 않음
      this.anchor = Math.max(this.anchor, r.anchor);
    } else {
      this.push({ t_us: r.tUs, event_type: "UI_CHANGE_FAILED", anchor: r.anchor, reason: r.reason });
    }
  }

  /** 남은 이벤트를 FINAL DATA 로 보내고 FINISH. STATE(ENDED), 연결 끊김, 3초 무응답 가운데 먼저 오는 것으로 풀림 */
  finish(reason = "submit"): Promise<SessionEnd> {
    const p = new Promise<SessionEnd>((resolve) => this.endWaiters.push(resolve));
    if (this.end) {
      this.resolveEnd();
      return p;
    }
    if (this.state === "connecting") {
      // WELCOME 전이라 보낼 번호 공간이 없음. 새 세션으로 다시 시작해야 함
      this.finishWith({ reason: "disconnected" });
      this.opts.transport.close(1000);
      return p;
    }
    if (!this.finishSent) {
      this.state = "finishing";
      this.flush(true);
      this.finishSent = true;
      this.finishAtUs = this.now();
      this.sendTracked(encodeFrame({
        header: header("CONTROL", this.nextSeq++, this.now()),
        control: { subtype: "FINISH", reason, last_data_seq: this.lastDataSeq, event_count: this.nextEventSeq - 1, collection_loss_count: this.lossCount },
      }));
    }
    return p;
  }

  /** 아직 ACK 못 받은 프레임(보낸 순서) */
  unacked(): Uint8Array[] {
    return this.pending.map((p) => p.bytes);
  }

  // ---------- 받기 ----------

  private onMessage(bytes: Uint8Array): void {
    if (this.state === "ended") return;
    let f: Obj;
    try {
      f = decodeFrame(bytes, this.dict);
    } catch (e) {
      if (!(e instanceof AvpError)) throw e;
      this.tap("rx", bytes);
      return this.fail(e.code, e.message);
    }
    const h = f.header;
    if (this.finishSent) this.rxSinceFinish = true;
    const record = this.tap("rx", bytes, f);
    if (h.msg_type === "ACK") return this.onAck(h.seq, f.ack, record);
    if (h.msg_type === "DATA") return this.fail("E_STATE", "서버가 DATA 를 보냄");
    if (h.seq !== this.serverSeq + 1) return this.fail("E_STATE", `서버 번호 ${h.seq}, 기대 ${this.serverSeq + 1}`);
    const sub = f.control?.subtype;
    if (typeof sub === "string" && CLIENT_ONLY.has(sub)) return this.fail("E_STATE", `서버가 ${sub} 를 보냄`);
    if (this.state === "connecting" && sub !== "WELCOME") return this.fail("E_STATE", "WELCOME 전에 다른 프레임");
    this.serverSeq = h.seq;

    if (typeof sub === "number") {
      // 모르는 subtype 은 비치명. 알린 뒤 ACK 하고 계속함
      this.sendError("E_SUBTYPE", false, `subtype ${sub}`);
    } else if (f.control) {
      this.onControl(f.control);
    } else if (h.msg_type === "INFERENCE_RESULT") {
      this.lastResult = f.result;
    }
    for (const cb of this.messageCbs) cb(f);
    // 위 처리(치명 ERROR, 방향 오류)로 이미 끝났으면 ACK 를 보내지 않음
    if ((this.state as SessionState) === "ended") return;
    this.sendAck();
    // 조각 확인 결과(asset_error, onCaptcha)는 그 조각의 ACK 뒤에 나가게 함
    if (h.msg_type === "ASSET_CHUNK") this.onAssetChunk(f.asset_chunk);
    if (h.msg_type === "STATE" && f.state.action_event_seq !== undefined) this.onVerdict(f.state);
    if (h.msg_type === "STATE" && f.state.state === "BLOCKED") {
      this.blocked = { reason: f.state.reason, windowId: f.state.window_id };
      // 차단이면 보호 행동을 진행하지 않고 세션을 끝냄. 이미 FINISH 를 보냈으면 ENDED 를 기다림
      if (!this.finishSent) void this.finish("blocked");
    }
    if (h.msg_type === "STATE" && f.state.state === "ENDED") {
      this.finishWith({ reason: String(f.state.reason) });
      this.opts.transport.close(1000);
    }
  }

  private onControl(c: Obj): void {
    switch (c.subtype) {
      case "WELCOME":
        if (this.state !== "connecting") return this.fail("E_STATE", "WELCOME 중복");
        this.sessionId = c.session_id;
        this.dict = c.dict;
        for (const k of Object.keys(this.config)) {
          const [lo, hi] = WELCOME_RANGE[k]!;
          (this.config as Record<string, number>)[k] = Math.min(hi, Math.max(lo, Number(c[k]) || 0));
        }
        this.state = "open";
        this.timer = this.opts.clock.setInterval(() => this.tick(), this.config.flush_ms);
        return;
      case "CHANGE_ORDER":
        if (this.finishSent) return; // FINISH 뒤에는 DATA 를 보낼 수 없어 실패 보고도 못 함(명세 사본 참고)
        if (this.state === "finishing") {
          this.push({ t_us: this.now(), event_type: "UI_CHANGE_FAILED", anchor: c.anchor, reason: "session_finishing" });
          return;
        }
        // 적용을 예약한 순간이 처리 완료. 실제 적용 결과는 reportChange 로 옴
        for (const cb of this.changeCbs) cb(c);
        return;
      case "FEATURE_SCHEMA":
        this.schema = c;
        return;
      case "CAPTCHA_CHALLENGE":
        this.onChallenge(c);
        return;
      case "CAPTCHA_RESULT":
        if (this.captcha?.c.challenge_id === c.challenge_id) this.captcha = undefined;
        return;
      case "STOP":
        void this.finish("stop");
        return;
      case "ERROR":
        if (c.fatal) {
          this.finishWith({ reason: "error", lastResult: this.lastResult });
          this.opts.transport.close(CLOSE_CODES[c.code] ?? 1000);
        }
        return;
    }
  }

  private onAck(seq: number, ack: Obj | undefined, record: TapRecord): void {
    if (seq >= this.nextSeq) return this.fail("E_STATE", `보낸 적 없는 번호 ${seq} 의 ACK`);
    const acked = this.pending.find((p) => p.seq === seq);
    if (ack && acked) record.ackCrcMatch = parseInt(ack.frame_crc32, 16) === crc32(acked.bytes);
    this.pending = this.pending.filter((p) => p.seq > seq);
  }

  // ---------- 보내기 ----------

  private tick(): void {
    this.captchaTimers();
    if (this.state === "finishing") {
      if (this.challengeOpen() && this.buffer.length) this.flush();
      const waited = this.now() - this.finishAtUs;
      const ttlMs = this.captcha?.c.ttl_ms ?? DEFAULT_TTL_MS;
      if (this.finishSent && ((!this.rxSinceFinish && waited >= FINISH_WAIT_US) || waited >= (ttlMs + FINISH_GRACE_MS) * 1000)) {
        this.finishWith({ reason: "timeout" });
        this.opts.transport.close(1000);
      }
      return;
    }
    if (this.state !== "open") return;
    if (this.buffer.length) this.flush();
    else if (this.now() - this.lastSendUs >= this.config.keepalive_ms * 1000) this.sendData({ events: [], flags: 0, startUs: this.now(), firstSeq: 0, bytes: 0 });
  }

  private flush(final = false): void {
    if (this.state !== "open" && this.state !== "finishing") return;
    // 프레임 안 dt 가 0 이상이 되게 시각 순으로 안정 정렬
    let events = this.buffer.splice(0).sort((a, b) => a.t_us - b.t_us);
    let dropped = 0;
    if (this.pending.length >= this.config.max_unacked_frames || this.pendingBytes() >= this.maxUnackedBytes) {
      const kept = events.filter((e) => e.event_type !== "POINTER_MOVE");
      dropped = events.length - kept.length;
      events = kept;
    }
    const frames = this.buildFrames(events, dropped);
    if (final) {
      if (!frames.length) frames.push({ events: [], flags: 0, startUs: this.now(), firstSeq: 0, bytes: 0 });
      frames[frames.length - 1]!.flags |= FLAG.FINAL;
    }
    for (const fr of frames) this.sendData(fr);
  }

  /** 이벤트를 프레임 상한에 맞게 나누고, 프레임마다 첫 이벤트로 CHECKPOINT 를 세워 혼자 디코드되게 함 */
  private buildFrames(events: Obj[], dropped: number): OutFrame[] {
    const out: OutFrame[] = [];
    let cur: (OutFrame & { prevUs: number; base?: { x: number; y: number } }) | undefined;
    const add = (e: Obj) => {
      let enc: Uint8Array;
      try {
        enc = encodeEvent({ ...e, event_seq: this.nextEventSeq }, cur!.prevUs, this.dict);
      } catch (err) {
        if (!(err instanceof AvpError)) throw err;
        // 사전에 없는 대상처럼 인코드할 수 없는 이벤트는 버리고 수집 누락으로 셈
        this.lossCount++;
        enc = encodeEvent({ t_us: e.t_us, event_type: "COLLECTION_LOSS", reason: "encode_failed", count: 1 }, cur!.prevUs);
      }
      cur!.events.push(enc);
      cur!.bytes += enc.length;
      cur!.prevUs = e.t_us;
      if (e._verdict) this.actionWaiters.set(this.nextEventSeq, e._verdict);
      this.nextEventSeq++;
      if (IMMEDIATE.has(e.event_type)) cur!.flags |= FLAG.ACK_REQUESTED;
    };
    const checkpoint = (tUs: number, pointerKnown = !!this.pointer) => {
      const p = this.pointer;
      add({
        t_us: tUs, event_type: "CHECKPOINT", pointer_known: pointerKnown && !!p, doc_visible: this.env.visible,
        window_focused: this.env.focused, pointer_type: this.env.pointerType, x: p?.x ?? 0, y: p?.y ?? 0,
        scroll_y: Math.max(0, Math.round(this.env.scrollY)), anchor: this.anchor,
      });
      cur!.base = pointerKnown && p ? { ...p } : undefined;
    };
    const newFrame = (e: Obj) => {
      cur = { events: [], flags: FLAG.HAS_CHECKPOINT, startUs: e.t_us, firstSeq: this.nextEventSeq, bytes: 0, prevUs: e.t_us };
      out.push(cur);
      if (e.event_type === "CHECKPOINT") this.absorb(e);
      checkpoint(e.t_us);
      if (dropped) {
        add({ t_us: e.t_us, event_type: "COLLECTION_LOSS", reason: "buffer_overflow", count: dropped });
        this.lossCount += dropped;
        cur!.flags |= FLAG.TRUNCATED;
        dropped = 0;
      }
    };

    for (const e of events) {
      // CHECKPOINT 하나와 이벤트 하나가 더 들어갈 자리를 남김
      const full = cur && (cur.events.length + 2 > this.config.max_events_per_frame || cur.bytes + 2 * (LIMITS.maxEventPayload + 3) > this.config.max_payload_bytes);
      if (!cur || full) {
        newFrame(e);
        if (e.event_type === "CHECKPOINT") continue; // 프레임 첫 CHECKPOINT 가 이 값을 담음
      }
      switch (e.event_type) {
        case "POINTER_MOVE": {
          if (!cur!.base) {
            // 위치를 모르는 프레임의 첫 이동은 그 위치를 절대 좌표로 담은 CHECKPOINT 뒤에 0 이동으로 보냄
            this.pointer = { x: e.x, y: e.y };
            checkpoint(e.t_us, true);
          }
          add({ t_us: e.t_us, event_type: "POINTER_MOVE", dx: e.x - cur!.base!.x, dy: e.y - cur!.base!.y });
          cur!.base = { x: e.x, y: e.y };
          this.pointer = { x: e.x, y: e.y };
          break;
        }
        case "POINTER_DOWN":
        case "POINTER_UP":
          add(e);
          this.pointer = { x: e.x, y: e.y };
          cur!.base = { ...this.pointer };
          break;
        case "CHECKPOINT":
          this.absorb(e);
          checkpoint(e.t_us);
          break;
        default:
          add(e);
      }
    }
    if (dropped) {
      // 남은 이벤트가 모두 이동이라 버려졌어도 누락은 알림
      newFrame({ t_us: this.now(), event_type: "_" });
    }
    return out;
  }

  /** 수집기가 보낸 CHECKPOINT 의 위치, 보임, 스크롤, 앵커를 이후 CHECKPOINT 에 씀 */
  private absorb(e: Obj): void {
    if (e.pointer_known) this.pointer = { x: e.x, y: e.y };
    if (e.pointer_type) this.env.pointerType = e.pointer_type;
    if (e.doc_visible !== undefined) this.env.visible = e.doc_visible;
    if (e.window_focused !== undefined) this.env.focused = e.window_focused;
    if (e.scroll_y !== undefined) this.env.scrollY = e.scroll_y;
    if (e.anchor !== undefined) this.anchor = Math.max(this.anchor, e.anchor);
  }

  // ---------- 캡챠 ----------

  private onVerdict(st: Obj): void {
    const resolve = this.actionWaiters.get(st.action_event_seq);
    if (!resolve) return;
    this.actionWaiters.delete(st.action_event_seq);
    const allowed = st.reason === "action_allowed" && st.state !== "BLOCKED";
    resolve({ allowed, eventSeq: st.action_event_seq, state: st.state, reason: st.reason, ...(allowed && st.action_token ? { token: st.action_token } : {}) });
  }

  /** FINISH 뒤에도 챌린지가 열려 있는 동안은 챌린지 화면 DATA 를 보냄(FINISH 앞뒤 어느 때 받았든) */
  private challengeOpen(): boolean {
    return !!this.captcha && !this.captcha.answered;
  }

  private onChallenge(c: Obj): void {
    const now = this.now();
    this.lastChallengeNo = c.challenge_no;
    this.captcha = {
      c, final: this.finishSent, assets: new Map(), assetDeadlineUs: now + CAPTCHA.assetWaitUs, ttlDeadlineUs: now + c.ttl_ms * 1000,
      delivered: false, answered: false,
    };
    const metaAssets: Obj[] = Array.isArray(c.meta?.assets) ? c.meta.assets : [];
    const bad = c.asset_count > CAPTCHA.assets || c.asset_total_bytes > CAPTCHA.totalBytes || metaAssets.length !== c.asset_count
      || metaAssets.some((a) => !CAPTCHA_TYPES.has(a?.type));
    if (bad) return this.sendAnswer("asset_error", {});
    if (c.asset_count === 0) this.deliverCaptcha();
  }

  private onAssetChunk(a: Obj): void {
    const cur = this.captcha;
    // 모르는 challenge_id 는 연결 오류가 아니라 무시
    if (!cur || a.challenge_id !== cur.c.challenge_id || cur.delivered || cur.answered) return;
    const data = fromHex(a.data_hex);
    const indices = new Set((cur.c.meta.assets as Obj[]).map((x) => x.index));
    if (data.length > CAPTCHA.chunkBytes || a.chunk_count < 1 || a.chunk_count > CAPTCHA.chunksPerAsset || a.chunk_index >= a.chunk_count || !indices.has(a.asset_index)) {
      return this.sendAnswer("asset_error", {});
    }
    const sha = String(a.asset_sha256).toLowerCase();
    let parts = cur.assets.get(a.asset_index);
    if (!parts) cur.assets.set(a.asset_index, (parts = { size: a.asset_size, sha, count: a.chunk_count, parts: new Map() }));
    if (parts.size !== a.asset_size || parts.sha !== sha || parts.count !== a.chunk_count) return this.sendAnswer("asset_error", {});
    parts.parts.set(a.chunk_index, data);
    const done = [...indices].every((i) => {
      const p = cur.assets.get(i);
      return !!p && p.parts.size === p.count;
    });
    if (done) this.deliverCaptcha();
  }

  private deliverCaptcha(): void {
    const cur = this.captcha!;
    const assets: CaptchaAsset[] = [];
    let total = 0;
    for (const m of cur.c.meta.assets as Obj[]) {
      const p = cur.assets.get(m.index)!;
      const bytes = concat(Array.from({ length: p.count }, (_, i) => p.parts.get(i)!));
      total += bytes.length;
      if (bytes.length !== p.size || toHex(sha256(bytes)).replace(/ /g, "").toLowerCase() !== p.sha) return this.sendAnswer("asset_error", {});
      assets.push({ index: m.index, name: String(m.name), type: String(m.type), bytes });
    }
    if (total > CAPTCHA.totalBytes) return this.sendAnswer("asset_error", {});
    cur.delivered = true;
    const c = cur.c;
    const out: CaptchaChallenge = { challengeId: c.challenge_id, challengeNo: c.challenge_no, windowId: c.window_id, reason: c.reason, ttlMs: c.ttl_ms, meta: c.meta, assets, final: cur.final };
    for (const cb of this.captchaCbs) cb(out);
  }

  private captchaTimers(): void {
    const cur = this.captcha;
    if (!cur || cur.answered) return;
    const now = this.now();
    if (!cur.delivered && now >= cur.assetDeadlineUs) this.sendAnswer("asset_error", {});
    else if (cur.delivered && now >= cur.ttlDeadlineUs) this.sendAnswer("timeout", {});
  }

  private sendAnswer(status: string, answer: Obj): void {
    const cur = this.captcha;
    if (!cur || cur.answered || this.state === "ended") return;
    // 챌린지 화면 행동(CAPTCHA_VIEW 등)이 답보다 먼저 서버에 들어가게 남은 이벤트를 먼저 보냄
    if (this.buffer.length && (!this.finishSent || this.challengeOpen())) this.flush();
    cur.answered = true;
    this.sendTracked(encodeFrame({
      header: header("CONTROL", this.nextSeq++, this.now()),
      control: { subtype: "CAPTCHA_ANSWER", challenge_id: cur.c.challenge_id, status, answer },
    }));
  }

  private sendData(fr: OutFrame): void {
    const seq = this.nextSeq++;
    const bytes = buildFrame(MSG.DATA, fr.flags, fr.events.length, seq, Math.max(0, fr.startUs), concat(fr.events));
    this.lastDataSeq = seq;
    this.lastSendUs = this.now();
    this.sendTracked(bytes);
  }

  private sendTracked(bytes: Uint8Array): void {
    const seq = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
    this.pending.push({ seq, bytes });
    this.send(bytes);
  }

  private sendAck(): void {
    this.send(buildFrame(MSG.ACK, 0, 0, this.serverSeq, this.now(), new Uint8Array()));
  }

  private sendError(code: string, fatal: boolean, message: string): void {
    // HELLO 전이면 0, 아니면 클라이언트 번호 공간의 다음 번호
    const seq = this.nextSeq++;
    this.send(encodeFrame({ header: header("CONTROL", seq, this.now()), control: { subtype: "ERROR", code, fatal, message: message.slice(0, 200) } }));
  }

  private send(bytes: Uint8Array): void {
    this.tap("tx", bytes);
    this.opts.transport.send(bytes);
  }

  private tap(dir: "tx" | "rx", bytes: Uint8Array, decoded?: Obj): TapRecord {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const r: TapRecord = {
      dir, bytes: bytes.slice(), byteLength: bytes.length, sessionUs: this.now(),
      msgType: bytes.length >= 4 ? bytes[3]! : 0, seq: bytes.length >= 12 ? dv.getUint32(8, true) : 0,
    };
    if (!this.tapCbs.length) return r;
    try {
      const f = decoded ?? decodeFrame(bytes, this.dict);
      r.decoded = f;
      if (f.events?.length) {
        r.firstEventSeq = f.events[0].event_seq;
        r.lastEventSeq = f.events.at(-1).event_seq;
      }
      const w = f.result?.window_id ?? f.model_input?.window_id ?? f.state?.window_id ?? f.control?.window_id;
      if (w !== undefined) r.windowId = w;
    } catch {
      // 디코드 실패한 바이트도 탭에는 그대로 남김. 오류 처리는 onMessage 가 함
    }
    for (const cb of this.tapCbs) cb(r);
    return r;
  }

  private fail(code: string, message: string): void {
    const fatal = code !== "E_SUBTYPE";
    this.sendError(code, fatal, message);
    if (!fatal) return;
    this.finishWith({ reason: "error" });
    this.opts.transport.close(CLOSE_CODES[code] ?? 4400);
  }

  private finishWith(e: SessionEnd): void {
    if (this.end) return;
    this.end = { ...e, lastResult: e.lastResult ?? this.lastResult };
    this.state = "ended";
    this.buffer = [];
    if (this.timer !== undefined) this.opts.clock.clearInterval(this.timer);
    this.timer = undefined;
    // 결과 없이 끝난 보호 행동은 허용하지 않음
    for (const [eventSeq, resolve] of this.actionWaiters) resolve({ allowed: false, eventSeq, state: "ENDED", reason: e.reason });
    this.actionWaiters.clear();
    this.resolveEnd();
  }

  private resolveEnd(): void {
    for (const w of this.endWaiters.splice(0)) w(this.end!);
  }

  private pendingBytes(): number {
    return this.pending.reduce((n, p) => n + p.bytes.length, 0);
  }

  private now(): number {
    return Math.max(0, Math.round(this.opts.clock.now()));
  }
}

function header(msgType: string, seq: number, tsUs: number): Obj {
  return { version: 1, msg_type: msgType, flags: [], event_count: 0, seq, timestamp_us: tsUs, payload_length: 0 };
}

function on<T>(list: T[], cb: T): () => void {
  list.push(cb);
  return () => {
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  };
}

