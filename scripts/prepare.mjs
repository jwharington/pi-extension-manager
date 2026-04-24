import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

let lefthookPackageJson;
try {
	lefthookPackageJson = require.resolve("lefthook/package.json");
} catch {
	console.log("lefthook not installed; skipping git hooks setup");
	process.exit(0);
}

const lefthookBin = join(dirname(lefthookPackageJson), "bin", "index.js");
const result = spawnSync(process.execPath, [lefthookBin, "install"], {
	stdio: "inherit",
});

if (result.error) {
	console.warn(`failed to run lefthook install: ${result.error.message}`);
	process.exit(0);
}

process.exit(result.status ?? 0);
