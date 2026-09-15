import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = "package";
const packDir = resolve(root, ".pack");
const npmCacheDir = resolve(root, ".npm-cache");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";

function run(command, args) {
  const result =
    process.platform === "win32" && command.endsWith(".cmd")
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", command, ...args],
          {
            cwd: root,
            encoding: "utf8",
          },
        )
      : spawnSync(command, args, {
          cwd: root,
          encoding: "utf8",
        });
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const hostBundlePath = resolve(root, "lib", "index.js");
const clientBundlePath = resolve(root, "lib", "client.js");
const clientSourcemapPath = resolve(root, "lib", "client.js.map");
const hostTypesPath = resolve(root, "lib", "types", "index.d.ts");
const clientTypesPath = resolve(root, "lib", "types", "client", "index.d.ts");

for (const target of [
  hostBundlePath,
  clientBundlePath,
  clientSourcemapPath,
  hostTypesPath,
  clientTypesPath,
]) {
  assert(existsSync(target), `missing build artifact: ${target}`);
}

const clientBundle = readFileSync(clientBundlePath, "utf8");
assert(
  /window\.__ModuleLoader__\.load\(\{\s*id:\s*"sental-dsh-annotation",\s*factory:\s*\(require\)\s*=>\s*\{/m.test(
    clientBundle,
  ),
  "client bundle is missing the lazy-CJS loader registration",
);
assert(
  clientBundle.includes("return module.exports;"),
  "client bundle does not return module.exports from the wrapper factory",
);

let tarballPath = "";
try {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(npmCacheDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  mkdirSync(npmCacheDir, { recursive: true });

  const packOutput = run(npmCommand, [
    "pack",
    "--json",
    "--cache",
    npmCacheDir,
    "--pack-destination",
    packDir,
  ]);
  const packRecords = JSON.parse(packOutput);
  assert(
    Array.isArray(packRecords) && packRecords.length === 1,
    "npm pack did not return one tarball record",
  );

  tarballPath = join(packDir, packRecords[0].filename);
  assert(existsSync(tarballPath), `tarball was not created: ${tarballPath}`);

  const tarEntries = run(tarCommand, ["-tf", tarballPath])
    .split(/\r?\n/)
    .filter(Boolean)
    .toSorted();

  const expectedEntries = [
    `${packageRoot}/DESIGN.md`,
    `${packageRoot}/LICENSE`,
    `${packageRoot}/README.md`,
    `${packageRoot}/cordis.patch.yml`,
    `${packageRoot}/lib/client.js`,
    `${packageRoot}/lib/client.js.map`,
    `${packageRoot}/lib/index.js`,
    `${packageRoot}/lib/types/client/index.d.ts`,
    `${packageRoot}/lib/types/index.d.ts`,
    `${packageRoot}/package.json`,
  ];

  for (const entry of expectedEntries) {
    assert(
      tarEntries.includes(entry),
      `tarball is missing expected entry: ${entry}`,
    );
  }

  for (const entry of tarEntries) {
    assert(
      !entry.startsWith(`${packageRoot}/src/`),
      `tarball must not publish source files: ${entry}`,
    );
    assert(
      !entry.startsWith(`${packageRoot}/tests/`),
      `tarball must not publish tests: ${entry}`,
    );
  }

  const packedManifest = run(tarCommand, [
    "-xOf",
    tarballPath,
    `${packageRoot}/package.json`,
  ]);
  assert(
    packedManifest.includes('"name": "sental-dsh-annotation"'),
    "packed package.json has the wrong package name",
  );
  assert(
    packedManifest.includes('"patch": "./cordis.patch.yml"'),
    "packed package.json is missing dsh.bundle.patch",
  );
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(packDir, { recursive: true, force: true });
  rmSync(npmCacheDir, { recursive: true, force: true });
}
