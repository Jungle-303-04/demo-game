import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["services", "tests", "scripts"];
const files = [];
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
}
for (const root of roots) await visit(root);
const violations = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  if (/\bchild_process\b|\bkubectl\b/.test(source)) violations.push(`${file}: 게임 런타임은 kubectl/child_process를 사용할 수 없다`);
  if (/sessionId.*(?:configmap|ConfigMap)|(?:configmap|ConfigMap).*sessionId/i.test(source)) violations.push(`${file}: sessionId 기반 ConfigMap 주입은 금지된다`);
  if (/metric_threshold|metrics_threshold|threshold_match/i.test(source)) violations.push(`${file}: Opsia 원인 룰에 수치 메트릭 임계 매칭을 둘 수 없다`);
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(`lint passed (${files.length} TypeScript files)`);

