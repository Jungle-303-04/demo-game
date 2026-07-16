import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OpsSnapshot } from "../../game-server/src/types.js";
import type { RoomRegistryRecord } from "../../room-orchestrator/src/registry.js";

interface TimelineEvent { at: string; type: string; detail: Record<string, unknown>; }
const port = Number(process.env.PORT ?? 8085);
const orchestrator = process.env.ORCHESTRATOR_URL ?? "http://room-orchestrator:8082";
const botRunner = process.env.BOT_RUNNER_URL ?? "http://bot-runner:8084";
const events: TimelineEvent[] = [];
const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {}; };
const send = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
const roomRecords = async (): Promise<RoomRegistryRecord[]> => (await (await fetch(`${orchestrator}/rooms`)).json() as { rooms: RoomRegistryRecord[] }).rooms;
const proxyJson = async (url: string, body: Record<string, unknown>): Promise<unknown> => { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(`${url}:${response.status}`); return response.json(); };

const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Opsia Demo Game</title><style>body{font:14px system-ui;margin:2rem;background:#0d1117;color:#dbe4ee}button,input{margin:.2rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{padding:.45rem;border-bottom:1px solid #30363d;text-align:left}canvas{width:480px;height:480px;border:1px solid #58a6ff;background:#111827}.red{color:#ff6b6b}.blue{color:#66b3ff}</style></head><body><h1>데모-게임 운영 화면</h1><form id="scale">룸 수 <input type="number" name="replicas" min="1" max="100" value="3"><button>적용</button></form><form id="bots">봇 수 <input type="number" name="count" min="1" max="500" value="30"><select name="mode"><option>normal</option><option>hack</option></select><button>투입</button></form><table><thead><tr><th>룸</th><th>상태</th><th>인원</th><th>생존</th><th>파드</th><th>QR</th><th>작업</th></tr></thead><tbody id="rooms"></tbody></table><h2 id="watch">관전</h2><button id="prev">이전 생존자</button><button id="next">다음 생존자</button><canvas id="map" width="480" height="480"></canvas><h2>Opsia 이벤트</h2><pre id="timeline"></pre><script>let current='room-0',focus=0;const $=s=>document.querySelector(s);async function api(p,o){return fetch(p,o).then(r=>r.json())}async function refresh(){let data=await api('/api/rooms');$('#rooms').innerHTML=data.rooms.map(r=>'<tr><td><button onclick="watchRoom(\\''+r.roomId+'\\')">'+r.roomId+'</button></td><td>'+r.status+'</td><td>'+r.players+'</td><td>'+r.alive+'</td><td>'+r.podName+'</td><td><a href="'+r.qrUrl+'">QR</a></td><td><button onclick="endRoom(\\''+r.roomId+'\\')">논리적 종료</button></td></tr>').join('');let line=await api('/api/timeline');$('#timeline').textContent=line.events.map(e=>e.at+' '+e.type).join('\\n');if(current)draw(await api('/api/ops/snapshot/'+current));}function draw(s){let c=$('#map'),x=c.getContext('2d');x.clearRect(0,0,480,480);(s.players||[]).forEach((p,i)=>{x.fillStyle=p.team==='red'?'#ff6b6b':'#66b3ff';x.beginPath();x.arc(p.x*4.8,p.y*4.8,i===focus?8:4,0,7);x.fill()});$('#watch').textContent='관전 '+s.roomId+' · '+((s.players||[])[focus]?.nickname||'생존자 없음');}window.watchRoom=r=>{current=r;focus=0;refresh()};window.endRoom=r=>api('/api/rooms/'+r+'/end',{method:'POST'}).then(refresh);$('#scale').onsubmit=e=>{e.preventDefault();api('/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({replicas:+e.target.replicas.value})}).then(refresh)};$('#bots').onsubmit=e=>{e.preventDefault();api('/api/bots/spawn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({count:+e.target.count.value,mode:e.target.mode.value})}).then(refresh)};$('#next').onclick=()=>{focus++;refresh()};$('#prev').onclick=()=>{focus=Math.max(0,focus-1);refresh()};setInterval(refresh,500);refresh();</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return response.end(page); }
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/api/rooms") {
      const records = await roomRecords();
      const rooms = await Promise.all(records.filter((room) => room.status !== "inactive").map(async (room) => {
        try { const summary = await (await fetch(`${room.endpoint}/summary`)).json() as { status: string; players: number; alive: number; strictMode: boolean; qrUrl: string }; return { ...room, ...summary }; }
        catch { return room; }
      }));
      return send(response, 200, { rooms });
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") return send(response, 200, await proxyJson(`${orchestrator}/rooms`, await readJson(request)));
    const end = url.pathname.match(/^\/api\/rooms\/(room-\d+)\/end$/);
    if (request.method === "POST" && end) { const room = (await roomRecords()).find((record) => record.roomId === end[1]); if (!room) return send(response, 404, { error: "room_not_found" }); return send(response, 200, await proxyJson(`${room.endpoint}/ops/end`, {})); }
    if (request.method === "POST" && url.pathname === "/api/bots/spawn") return send(response, 201, await proxyJson(`${botRunner}/bots/spawn`, await readJson(request)));
    if (request.method === "POST" && url.pathname === "/api/bots/kill") return send(response, 200, await proxyJson(`${botRunner}/bots/kill`, await readJson(request)));
    const snapshot = url.pathname.match(/^\/api\/ops\/snapshot\/(room-\d+)$/);
    if (request.method === "GET" && snapshot) { const room = (await roomRecords()).find((record) => record.roomId === snapshot[1]); if (!room) return send(response, 404, { error: "room_not_found" }); return send(response, 200, await (await fetch(`${room.endpoint}/ops/snapshot`)).json() as OpsSnapshot); }
    if (request.method === "POST" && url.pathname === "/api/ops/events") { const body = await readJson(request); const type = String(body.type ?? ""); if (!type) return send(response, 400, { error: "event_type_required" }); events.unshift({ at: new Date().toISOString(), type, detail: body }); events.splice(50); return send(response, 202, { accepted: true }); }
    if (request.method === "GET" && url.pathname === "/api/timeline") return send(response, 200, { events });
    return send(response, 404, { error: "not_found" });
  } catch (error) { return send(response, 502, { error: error instanceof Error ? error.message : "upstream_error" }); }
});
server.listen(port, () => process.stdout.write(`${JSON.stringify({ level: "info", event: "ops_console_listening", detail: { port } })}\n`));
