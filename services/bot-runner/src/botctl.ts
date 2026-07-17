import { readControlToken, withControlToken } from "../../control-plane-auth.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const base = process.env.BOT_RUNNER_URL ?? "http://localhost:8084";
const controlToken = readControlToken();
const command = args[0];
if (command === "spawn") {
  const count = Number(option("--count")); const mode = option("--mode") ?? "normal";
  if (!Number.isInteger(count) || count < 1 || !["normal", "hack"].includes(mode)) throw new Error("usage: botctl spawn --count M [--room R] [--mode normal|hack]");
  const response = await fetch(`${base}/bots/spawn`, withControlToken({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count, room: option("--room"), mode, nickname: option("--nickname") }) }, controlToken));
  if (!response.ok) throw new Error(await response.text()); process.stdout.write(`${JSON.stringify(await response.json())}\n`);
} else if (command === "kill") {
  const response = await fetch(`${base}/bots/kill`, withControlToken({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: option("--id") ?? option("--session") }) }, controlToken));
  if (!response.ok) throw new Error(await response.text()); process.stdout.write(`${JSON.stringify(await response.json())}\n`);
} else throw new Error("usage: botctl spawn|kill");
