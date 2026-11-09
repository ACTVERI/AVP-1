// 시험용 AVP/1 v0.2 판별 서버. 명세의 서버 쪽 규칙(버퍼에 넣은 뒤 ACK, CRC32, 화면 변화 지시, FINISH 뒤 마지막 결과)만 흉내 냄
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { crc32, decodeFrame, encodeFrame, type Obj } from "../../src/codec.js";

export const DICT = { targets: ["", "search_box", "result_list", "cart_button"], routes: ["", "/shop", "/shop/cart"] };

export interface ServerOptions {
  /** true 를 돌려준 번호는 버퍼에 넣되 ACK 를 보내지 않음 */
  dropAck?: (seq: number) => boolean;
  /** CHANGE_ORDER 를 같은 번호로 두 번 보냄 */
  duplicateChangeOrder?: boolean;
  /** FINISH 를 받으면 보낼 마지막 점수. null 이면 근거 부족으로 끝냄 */
  finalScore?: number | null;
}

export interface ServerSession {
  hello: Obj;
  query: string;
  frames: Map<number, Obj>;
  events: Obj[];
  clientAcks: number[];
  errors: Obj[];
  state: "open" | "ended";
}

export interface LoopbackServer {
  port: number;
  sessions: ServerSession[];
  close(): Promise<void>;
}

const hdr = (msg_type: string, seq: number, flags: string[] = []) => ({ version: 1, msg_type, flags, event_count: 0, seq, timestamp_us: 0, payload_length: 0 });

export async function startLoopback(opts: ServerOptions = {}): Promise<LoopbackServer> {
  const sessions: ServerSession[] = [];
  const http: Server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server: http, path: "/avp/1/ws", handleProtocols: (p) => (p.has("avp.1") ? "avp.1" : false) });

  wss.on("connection", (ws, req) => {
    let s: ServerSession | undefined;
    let serverSeq = 0;
    let changeSent = false;
    let lastAcked = 0;
    const send = (f: Obj, times = 1) => {
      f.header.seq = ++serverSeq;
      const b = encodeFrame(f, DICT);
      for (let i = 0; i < times; i++) ws.send(b);
    };
    ws.on("message", (raw: Buffer) => {
      const bytes = new Uint8Array(raw);
      const f = decodeFrame(bytes, s ? DICT : undefined);
      if (!s) {
        if (f.control?.subtype !== "HELLO") return ws.close(4401);
        s = { hello: f.control, query: new URL(req.url!, "http://x").search, frames: new Map(), events: [], clientAcks: [], errors: [], state: "open" };
        sessions.push(s);
        send({ header: hdr("CONTROL", 0), control: {
          subtype: "WELCOME", session_id: "019a6a3c5e107c4b8f213d9e0b7a4c12", server_open_unix_us: Date.now() * 1000, caps: 0, server_flags: 15,
          flush_ms: 20, keepalive_ms: 15000, infer_interval_ms: 1000, window_ms: 10000, min_action_events: 3, captcha_threshold_milli: 0,
          captcha_sustain_ms: 10000, max_payload_bytes: 65536, max_events_per_frame: 1024, max_unacked_frames: 64, dict: DICT,
        } });
        return;
      }
      if (f.header.msg_type === "ACK") {
        s.clientAcks.push(f.header.seq);
        return;
      }
      if (f.control?.subtype === "ERROR") s.errors.push(f.control);
      s.frames.set(f.header.seq, f);
      if (f.events) s.events.push(...f.events.map((e: Obj) => ({ ...e, seq: f.header.seq })));
      // 버퍼에 넣은 뒤 누적 ACK. 페이로드는 마지막 프레임의 CRC32 와 디코드한 이벤트 수
      if (!opts.dropAck?.(f.header.seq)) {
        lastAcked = f.header.seq;
        ws.send(encodeFrame({ header: hdr("ACK", lastAcked), ack: { frame_crc32: crc32(bytes).toString(16).toUpperCase().padStart(8, "0"), decoded_events: f.events?.length ?? 0 } }));
      }
      if (!changeSent && f.events?.some((e: Obj) => e.event_type === "NAVIGATION_END" && e.route === "/shop")) {
        changeSent = true;
        send({ header: hdr("CONTROL", 0), control: { subtype: "CHANGE_ORDER", anchor: 1, kind: "price_update", target_av: "result_list", deadline_ms: 8000, require_route: "/shop", params: { item: "p2", price: 31900 } } }, opts.duplicateChangeOrder ? 2 : 1);
      }
      if (f.control?.subtype === "FINISH") {
        const n = s.events.length;
        const score = opts.finalScore === undefined ? 0.25 : opts.finalScore;
        if (score === null) {
          send({ header: hdr("STATE", 0), state: { state: "ENDED", reason: "insufficient_data", window_id: 0 } });
        } else {
          send({ header: hdr("INFERENCE_RESULT", 0, ["FINAL"]), result: { window_id: 1, window_start_ms: 0, window_end_ms: 1000, event_count: n, ai_score: score, first_event_seq: 1, last_event_seq: f.control.event_count } });
          send({ header: hdr("STATE", 0), state: { state: "ENDED", reason: "finish", window_id: 1 } });
        }
        s.state = "ended";
      }
    });
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    port: (http.address() as AddressInfo).port,
    sessions,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => r());
      }),
  };
}
