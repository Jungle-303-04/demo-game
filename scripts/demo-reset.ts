const base = process.env.OPS_CONSOLE_URL ?? "http://localhost:8085";
const response = await fetch(`${base}/api/rooms`);
if (!response.ok) throw new Error(`ops_console_unavailable:${response.status}`);
const { rooms } = await response.json() as { rooms: Array<{ roomId: string }> };
await fetch(`${base}/api/bots/kill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
await Promise.all(rooms.map(async ({ roomId }) => {
  const ended = await fetch(`${base}/api/rooms/${roomId}/end`, { method: "POST" });
  if (!ended.ok) throw new Error(`room_reset_failed:${roomId}`);
}));
process.stdout.write(JSON.stringify({ resetRooms: rooms.map((room) => room.roomId) }) + "\n");
