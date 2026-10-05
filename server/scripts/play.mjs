// tako:run node scripts/play.mjs
// 動いている Worker（wrangler dev など）に WebSocket のクライアントを 2 つつなぎ、1 局を最後まで打つ。
// 途中で 存在しない部屋・満員の部屋への参加・対局途中の切断と再接続・終局後の手 も確かめる。
// 使い方: node scripts/play.mjs [サイトのオリジン=http://localhost:8787] [プリセット=king]（API はその /api の下）
// 手は engine を使わず「空きマスと持ち駒を順に試し、illegal_move なら次」で選ぶ（どのプリセットでも打てる）。

const BASE = process.argv[2] ?? "http://localhost:8787";
const PRESET = process.argv[3] ?? "king";
const API = `${BASE.replace(/\/+$/, "")}/api`;
const WS_API = API.replace(/^http/, "ws");
const KINDS = ["fu", "yoko", "gin", "kaku", "kin", "hi"];

const leaks = [];
const log = (who, ...a) => console.log(`[${who}]`.padEnd(8), ...a);

class Client {
  constructor(name, roomId) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(`${WS_API}/rooms/${roomId}/ws`);
    this.ws.addEventListener("message", (e) => {
      // 隠し王の真の状態（kings）が届いたら漏れている
      if (e.data.includes('"kings"')) leaks.push(`${name}: ${e.data.slice(0, 120)}`);
      this.push(JSON.parse(e.data));
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.push(null);
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }
  push(m) {
    const w = this.waiters.shift();
    if (w) w(m);
    else this.queue.push(m);
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: メッセージが来ない`)), 5000);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  async expect(type) {
    const m = await this.next();
    if (m === null) throw new Error(`${this.name}: 接続が閉じた ${JSON.stringify(this.closed)}`);
    if (m.type !== type) throw new Error(`${this.name}: ${type} のはずが ${JSON.stringify(m).slice(0, 200)}`);
    return m;
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  async join(token) {
    await this.opened;
    this.send(token ? { type: "join", token } : { type: "join" });
    const joined = await this.expect("joined");
    const state = await this.expect("state");
    return { joined, state };
  }
  async closedWith() {
    while (!this.closed) await this.next();
    return this.closed;
  }
}

const names = "abcdefgh";
const cell = (r, c) => `${names[c]}${r + 1}`;

/** 打てる手を探して打つ。打てたら両者の state を返す */
async function playOne(mover, other, view) {
  const designate = view.myKing.canDesignate && view.myKing.nextMove === 1;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (view.board[r][c] !== null) continue;
      for (const kind of KINDS) {
        if (view.hands[view.viewer][kind] <= 0) continue;
        mover.send({ type: "move", r, c, kind, king: designate });
        const m = await mover.next();
        if (m.type === "error" && m.code === "illegal_move") continue;
        if (m.type !== "state") throw new Error(`想定外: ${JSON.stringify(m)}`);
        const o = await other.expect("state");
        return { move: `${cell(r, c)} ${kind}${designate ? "（王）" : ""}`, mine: m, theirs: o };
      }
    }
  }
  throw new Error("打てる手がない");
}

async function main() {
  log("http", `サーバー ${BASE} / プリセット ${PRESET}`);
  const page = await fetch(`${BASE}/`);
  log("http", "GET / →", page.status, page.headers.get("Content-Type"));
  const health = await fetch(`${API}/health`);
  log("http", "GET /api/health →", health.status, await health.text());

  // 存在しない部屋
  const missing = await fetch(`${API}/rooms/AAAAAAAAAAAAAAAAAAAAAA`);
  log("http", "GET /api/rooms/(存在しない) →", missing.status, await missing.text());
  const ghost = new Client("ghost", "AAAAAAAAAAAAAAAAAAAAAA");
  await ghost.opened;
  const ghostErr = await ghost.next();
  log("ghost", "WebSocket で存在しない部屋 →", JSON.stringify(ghostErr), "close", (await ghost.closedWith()).code);

  // 部屋を作る
  const res = await fetch(`${API}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: PRESET, hostSeat: "first" }),
  });
  const created = await res.json();
  log("http", "POST /api/rooms →", res.status, JSON.stringify({ ...created, token: created.token.slice(0, 6) + "…" }));

  const host = new Client("host", created.roomId);
  let { joined: hj, state: hs } = await host.join(created.token);
  log("host", `joined you=${hj.you} phase=${hs.phase} opponent=${JSON.stringify(hs.opponent)}`);
  const guest = new Client("guest", created.roomId);
  const { joined: gj, state: gs0 } = await guest.join();
  let gs = gs0;
  log("guest", `joined you=${gj.you} phase=${gs.phase} opponent=${JSON.stringify(gs.opponent)}`);
  hs = await host.expect("state");
  log("host", `相手が参加 phase=${hs.phase} opponent=${JSON.stringify(hs.opponent)}`);

  // 満員の部屋への 3 人目
  const third = new Client("third", created.roomId);
  await third.opened;
  third.send({ type: "join" });
  log("third", "→", JSON.stringify(await third.next()), "close", (await third.closedWith()).code);

  // 手番違い
  guest.send({ type: "move", r: 2, c: 3, kind: "fu" });
  log("guest", "先手番に手を送る →", JSON.stringify(await guest.next()));

  let hostClient = host;
  let hostToken = hj.token;
  let reconnected = false;
  while (hs.phase === "playing") {
    const hostTurn = hs.view.turn === hs.you;
    const [mover, other, view] = hostTurn ? [hostClient, guest, hs.view] : [guest, hostClient, gs.view];
    const r = await playOne(mover, other, view);
    if (hostTurn) [hs, gs] = [r.mine, r.theirs];
    else [gs, hs] = [r.mine, r.theirs];
    const last = hs.view.history.at(-1);
    const hit = last?.type === "move" && last.king ? ` 王を返した(罰${last.king.penalty})` : "";
    log(mover.name, `${String(hs.view.ply).padStart(2)} 手目 ${r.move} → 体力 先手${hs.view.hp[0]} 後手${hs.view.hp[1]}${hit}`);

    // 対局途中で先手が切断し、トークンで戻る
    if (!reconnected && hs.view.ply === 6 && hs.phase === "playing") {
      reconnected = true;
      hostClient.ws.close();
      gs = await guest.expect("state");
      log("guest", `先手が切断 → opponent=${JSON.stringify(gs.opponent)}`);
      hostClient = new Client("host", created.roomId);
      const back = await hostClient.join(hostToken);
      hs = back.state;
      hostToken = back.joined.token;
      log("host", `再接続 you=${back.joined.you} ply=${hs.view.ply} 自分の王=${JSON.stringify(hs.view.myKing.cell)}`);
      gs = await guest.expect("state");
      log("guest", `先手が復帰 → opponent=${JSON.stringify(gs.opponent)}`);
    }
  }

  const result = hs.view.result;
  log("host", `終局 phase=${hs.phase} result=${JSON.stringify(result)}`);
  log("guest", `終局 phase=${gs.phase} result=${JSON.stringify(gs.view.result)}`);
  if (JSON.stringify(result) !== JSON.stringify(gs.view.result)) throw new Error("両者の結果が違う");

  hostClient.send({ type: "move", r: 0, c: 0, kind: "fu" });
  log("host", "終局後に手を送る →", JSON.stringify(await hostClient.next()));
  const info = await (await fetch(`${API}/rooms/${created.roomId}`)).json();
  log("http", `GET /api/rooms/:id → phase=${info.phase} open=${info.open}`);

  if (leaks.length > 0) throw new Error(`kings が届いた: ${leaks.join(" / ")}`);
  log("check", "どのメッセージにも kings（隠し王の真の状態）はなかった");
  hostClient.ws.close();
  guest.ws.close();
  log("done", "1 局を最後まで打てた");
}

main().catch((e) => {
  console.error("失敗:", e);
  process.exit(1);
});
