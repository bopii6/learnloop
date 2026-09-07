// 自定义 Next 服务：在同一个 HTTP 端口上挂 WebSocket（/ws/classroom）。
// 职责：课堂状态通道 —— 接收客户端的"剧本/播放游标/白板元素快照/对话记录"，
// 持久化到 data/classrooms/{room}.json，重连时回放，实现断线恢复与断点续播。
// 启动方式：node server.mjs（dev 与 production 同一套）。
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import next from "next";
import { WebSocketServer } from "ws";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);

const app = next({ dev });
const handle = app.getRequestHandler();

const CLASSROOM_DIR = path.join(process.cwd(), "data", "classrooms");

function roomFile(room) {
  const safe = String(room).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(CLASSROOM_DIR, `${safe}.json`);
}

// room → { state, saveTimer }（写盘节流）
const rooms = new Map();
const SAVE_DEBOUNCE_MS = 1200;

async function persistRoom(room) {
  const entry = rooms.get(room);
  if (!entry) return;
  try {
    await fs.mkdir(CLASSROOM_DIR, { recursive: true });
    entry.state.updated_at = new Date().toISOString();
    await fs.writeFile(roomFile(room), JSON.stringify(entry.state), "utf8");
  } catch (e) {
    console.error("[ws] persist failed:", room, e.message);
  }
}

function scheduleSave(room) {
  let entry = rooms.get(room);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => void persistRoom(room), SAVE_DEBOUNCE_MS);
}

async function loadRoom(room) {
  if (rooms.has(room)) return rooms.get(room).state;
  try {
    const raw = await fs.readFile(roomFile(room), "utf8");
    const state = JSON.parse(raw);
    const entry = { state, timer: null };
    rooms.set(room, entry);
    return state;
  } catch {
    return null;
  }
}

function updateRoom(room, patch) {
  let entry = rooms.get(room);
  if (!entry) {
    entry = { state: { room, script: [], messages: [], elements: [], cursor: 0, ...patch }, timer: null };
    rooms.set(room, entry);
  }
  Object.assign(entry.state, patch);
  scheduleSave(room);
  return entry.state;
}

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/ws/classroom") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    let joinedRoom = null;

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { type, room } = msg;
      if (!type) return;

      if (type === "join") {
        joinedRoom = String(room || "");
        const state = (await loadRoom(joinedRoom)) || { room: joinedRoom, script: [], messages: [], elements: [], cursor: 0 };
        if (!rooms.has(joinedRoom)) rooms.set(joinedRoom, { state, timer: null });
        ws.send(JSON.stringify({ type: "joined", room: joinedRoom, state }));
        return;
      }

      if (!joinedRoom) return;

      switch (type) {
        case "script":
          // 客户端收到剧本（可能分多次到达）→ 增量合并
          {
            const state = await loadRoom(joinedRoom);
            const incoming = Array.isArray(msg.segments) ? msg.segments : [];
            const byId = new Map((state.script || []).map((s) => [s.segmentId, s]));
            for (const seg of incoming) byId.set(seg.segmentId, seg);
            updateRoom(joinedRoom, { script: [...byId.values()], points: msg.points || state.points || [] });
          }
          ws.send(JSON.stringify({ type: "saved", what: "script" }));
          break;
        case "progress":
          // 播放游标 + 白板元素快照 + 对话记录（客户端为播放事实源）
          console.log(`[ws] progress room=${joinedRoom} cursor=${msg.cursor} writer=${typeof msg.writer}`);
          updateRoom(joinedRoom, {
            cursor: Number(msg.cursor) || 0,
            elements: Array.isArray(msg.elements) ? msg.elements : [],
            messages: Array.isArray(msg.messages) ? msg.messages : [],
            writer: msg.writer || undefined,
          });
          ws.send(JSON.stringify({ type: "saved", what: "progress", cursor: msg.cursor }));
          break;
        case "ask":
          // 学员提问经 WS 转发（为未来多端同步预留；当前回显给发送方确认链路）
          ws.send(JSON.stringify({ type: "ask_ack", text: String(msg.text || "").slice(0, 200) }));
          break;
        case "end":
          // 主动结束课堂 → 清空该课堂的恢复状态（writer 快照一并清掉，避免恢复出残局画面）
          updateRoom(joinedRoom, { script: [], messages: [], elements: [], cursor: 0, writer: undefined });
          await persistRoom(joinedRoom);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      if (joinedRoom) void persistRoom(joinedRoom);
    });
  });

  server.listen(port, () => {
    console.log(`> LearnLoop ready on http://localhost:${port} (ws: /ws/classroom)`);
  });
});
