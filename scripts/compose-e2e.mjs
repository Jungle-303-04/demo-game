import { spawnSync } from "node:child_process";

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("docker", ["compose", "down", "-v"]);
run("docker", ["compose", "up", "--build", "-d"]);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath_missing");
run(process.execPath, [npmCli, "run", "build"], { ...process.env, COMPOSE_E2E: "1" });
run(process.execPath, ["--test", "dist/tests/e2e/compose-api.test.js"], {
  ...process.env,
  COMPOSE_E2E: "1",
});
