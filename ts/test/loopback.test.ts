import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Obj } from "../src/codec.js";
import { createActveri, defaultClock, type Actveri } from "../src/sdk.js";
import type { TapRecord } from "../src/session.js";
import type { WebSocketLike } from "../src/transport-ws.js";
import { startLoopback, type LoopbackServer, type ServerOptions } from "./helpers/loopback-server.js";

let server: LoopbackServer | undefined;
let sdk: Actveri | undefined;
afterEach(async () => {
  sdk?.stop();
  await server?.close();
  server = sdk = undefined;
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다린 조건이 시간 안에 참이 되지 않음");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(opts: ServerOptions = {}) {
  server = await startLoopback(opts);
  const clock = defaultClock();
  const orders: Obj[] = [];
  const taps: TapRecord[] = [];
  sdk = createActveri({
    clientKey: "pk_stlab_demo",
    missionId: "mission_compare_v1",
    missionKind: "custom_mission",
    runFlags: 4,
    endpoint: `ws://127.0.0.1:${server.port}/avp/1/ws`,
    WebSocketImpl: WebSocket as unknown as new (u: string, p: string) => WebSocketLike,
    clock,
    handlers: {
      onChangeOrder: (order, report) => {
        orders.push(order);
        setTimeout(() => report({ anchor: order.anchor, ok: true, tUiUs: clock.now(), applyLagUs: 16000, visiblePct: 100 }), 1);
      },
      onTap: (r) => taps.push(r),
    },
  });
  await waitFor(() => sdk!.session.state === "open");
  return { a: sdk, clock, orders, taps, ss: () => server!.sessions[0]! };
}

const wheel = (t: number): Obj => ({ t_us: t, event_type: "WHEEL", wheel_dx: 0, wheel_dy: 10, wheel_delta_mode: "pixel", target: null });
const nav = (t: number, route: string): Obj => ({ t_us: t, event_type: "NAVIGATION_END", source: "dom", nav_type: "push", route });

describe("loopback: SDK와 시험용 판별 서버", () => {
  it("HELLO 부터 마지막 결과까지 번호가 빠짐없고, 변화 지시 뒤 앵커가 바뀌고, ACK CRC32 가 TX 사본과 맞음", async () => {
    const { a, clock, orders, taps, ss } = await connect();
    expect(ss().query).toBe("?k=pk_stlab_demo");
    expect(ss().hello).toMatchObject({ proto_minor: 3, client_key: "pk_stlab_demo", mission_kind: "custom_mission", run_flags: 4 });
    a.push({ t_us: clock.now(), event_type: "POINTER_MOVE", x: 100, y: 200 });
    a.push({ t_us: clock.now() + 1, event_type: "POINTER_MOVE", x: 104, y: 198 });
    a.push(nav(clock.now() + 2, "/shop"));
    await waitFor(() => ss().events.some((e) => e.event_type === "UI_CHANGE_RENDERED"));
    a.push(wheel(clock.now()));
    await sleep(40);
    const end = await a.finish();

    expect(end).toMatchObject({ reason: "finish", lastResult: { ai_score: 0.25 } });
    expect(orders).toHaveLength(1);
    const seqs = [...ss().frames.keys()].sort((x, y) => x - y);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(ss().clientAcks).toEqual(ss().clientAcks.map((_, i) => i + 1));
    expect(ss().state).toBe("ended");
    expect(a.session.state).toBe("ended");

    const evs = ss().events;
    expect(evs.map((e) => e.event_seq)).toEqual(evs.map((_, i) => i + 1));
    expect(evs.find((e) => e.event_type === "UI_CHANGE_RENDERED")).toMatchObject({ anchor: 1, apply_lag_us: 16000 });
    expect(evs.filter((e) => e.event_type === "CHECKPOINT").at(-1)).toMatchObject({ anchor: 1 });
    expect(evs.filter((e) => e.event_type === "POINTER_MOVE").map((e) => [e.x, e.y])).toEqual([[100, 200], [104, 198]]);
    const fin = ss().frames.get(seqs.at(-1)!)!.control;
    expect(fin).toMatchObject({ subtype: "FINISH", reason: "submit", event_count: evs.length, collection_loss_count: 0 });

    const ackTaps = taps.filter((t) => t.dir === "rx" && t.msgType === 2);
    expect(ackTaps.length).toBeGreaterThan(0);
    expect(ackTaps.every((t) => t.ackCrcMatch === true)).toBe(true);
    expect(taps.find((t) => t.dir === "rx" && t.msgType === 4)).toMatchObject({ windowId: 1 });
  });

  it("ACK 하나가 빠져도 다음 누적 ACK 가 앞 프레임까지 지움", async () => {
    const { a, clock, ss } = await connect({ dropAck: (seq) => seq === 2 });
    for (let k = 0; k < 3; k++) {
      a.push(wheel(clock.now()));
      await sleep(40);
    }
    await waitFor(() => ss().frames.size >= 3);
    await waitFor(() => a.session.unacked().length === 0);
    expect((await a.finish()).reason).toBe("finish");
  });

  it("근거가 모자라면 STATE(ENDED, insufficient_data) 로 끝나고 결과 없이도 끝을 알림", async () => {
    const { a } = await connect({ finalScore: null });
    await expect(a.finish()).resolves.toEqual({ reason: "insufficient_data", lastResult: undefined });
  });

  it("서버가 같은 번호의 CHANGE_ORDER 를 두 번 보내면 한 번만 적용하고 E_STATE 로 닫음", async () => {
    const { a, clock, orders, ss } = await connect({ duplicateChangeOrder: true });
    a.push(nav(clock.now(), "/shop"));
    await waitFor(() => a.session.state === "ended");
    expect(orders).toHaveLength(1);
    await waitFor(() => ss().errors.length > 0);
    expect(ss().errors[0]).toMatchObject({ code: "E_STATE", fatal: true });
  });
});
