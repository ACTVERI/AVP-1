import { describe, expect, it } from "vitest";
import { wsTransport, type WebSocketLike } from "../src/transport-ws.js";

function fakeWs(): WebSocketLike & { sent: Uint8Array[] } {
  const ws = {
    binaryType: "blob", readyState: 0, sent: [] as Uint8Array[],
    send(d: Uint8Array) { this.sent.push(d); }, close() {},
    onopen: null, onmessage: null, onclose: null,
  } as WebSocketLike & { sent: Uint8Array[] };
  return ws;
}

describe("wsTransport", () => {
  it("열리기 전에 보낸 바이트는 모았다가 열릴 때 순서대로 보냄", () => {
    const ws = fakeWs();
    const t = wsTransport(ws);
    t.send(Uint8Array.of(1));
    t.send(Uint8Array.of(2));
    expect(ws.sent).toEqual([]);
    ws.readyState = 1;
    ws.onopen!({});
    t.send(Uint8Array.of(3));
    expect(ws.sent.map((b) => b[0])).toEqual([1, 2, 3]);
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("받은 ArrayBuffer와 텍스트를 모두 바이트로 넘기고 닫기 코드를 전함", () => {
    const ws = fakeWs();
    const t = wsTransport(ws);
    const got: Uint8Array[] = [];
    const codes: number[] = [];
    t.onMessage((b) => got.push(b));
    t.onClose((c) => codes.push(c));
    ws.onmessage!({ data: Uint8Array.of(0x41, 0x56).buffer });
    ws.onmessage!({ data: "hi" });
    ws.onclose!({ code: 1006 });
    expect(got.map((b) => Array.from(b))).toEqual([[0x41, 0x56], [0x68, 0x69]]);
    expect(codes).toEqual([1006]);
  });
});
