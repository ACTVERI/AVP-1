// 브라우저 WebSocket(또는 같은 모양의 객체)을 Session 의 Transport 로 맞추는 어댑터
import type { Transport } from "./session.js";

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
}

const CONNECTING = 0;
const OPEN = 1;

export function wsTransport(ws: WebSocketLike): Transport {
  ws.binaryType = "arraybuffer";
  // 연결이 열리기 전에 Session 이 HELLO 를 보내므로 열릴 때까지 모아 둠
  const queue: Uint8Array[] = [];
  ws.onopen = () => {
    for (const b of queue.splice(0)) ws.send(b);
  };
  return {
    send(bytes) {
      if (ws.readyState === CONNECTING) queue.push(bytes);
      else if (ws.readyState === OPEN) ws.send(bytes);
    },
    onMessage(cb) {
      ws.onmessage = (ev) => {
        // 텍스트 메시지는 바이트로 바꿔 넘겨 디코더가 E_MAGIC 으로 거절하게 함
        const d = ev.data;
        cb(d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new TextEncoder().encode(String(d)));
      };
    },
    onClose(cb) {
      ws.onclose = (ev) => cb(ev.code);
    },
    close(code) {
      ws.close(code);
    },
  };
}
