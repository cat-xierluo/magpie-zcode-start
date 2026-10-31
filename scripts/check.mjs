import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "magpie-zcode-start-"));

// The package tests deliberately refuse a real HOME so they cannot read ZCode data.
const result = spawnSync("bun", ["test"], {
  cwd: root,
  env: { ...process.env, HOME: home },
  stdio: "inherit",
});

await rm(home, { recursive: true, force: true });

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
