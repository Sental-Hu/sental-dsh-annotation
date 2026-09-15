import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const packageJsonPath = resolve(root, "package.json");
const patchPath = resolve(root, "cordis.patch.yml");

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<
    string,
    unknown
  >;
}

function readPackageFiles(): string[] {
  const manifest = readPackageJson();
  const files = manifest.files;
  expect(Array.isArray(files)).toBe(true);
  return [...(files as string[])];
}

describe("standalone package contract", () => {
  it("depends on public conversation capabilities rather than a removed runtime", () => {
    const manifest = readPackageJson();
    expect(manifest.name).toBe("dsh-annotation");
    expect(manifest.version).toMatch(/^0\.1\.\d+$/);
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");

    const dsh = manifest.dsh as {
      bundle?: { patch?: string };
      client?: { platform?: string; inject?: string[]; external?: string[] };
    };

    expect(dsh.bundle?.patch).toBe("./cordis.patch.yml");
    expect(dsh.client?.platform).toBe("web");
    expect(dsh.client?.inject).toEqual([
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-input-trigger",
    ]);
    expect(dsh.client?.external).toEqual(["react"]);

    expect(manifest.dependencies).toEqual({
      zod: "^4.4.3",
    });
    expect(manifest.peerDependencies).toEqual({
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-storage-domain":
        ">=0.1.0-rc.8 <0.2.0 || >=0.1.5-rc.1 <0.1.5",
    });
    expect(manifest.devDependencies).toMatchObject({
      "@deepseek-ai/cordis": "4.0.1",
      "@deepseek-ai/dsh-storage-domain": "0.1.0-rc.8",
    });

    expect(manifest.main).toBe("lib/index.js");
    expect(manifest.types).toBe("lib/types/index.d.ts");
    expect(manifest.exports).toEqual({
      ".": {
        types: "./lib/types/index.d.ts",
        default: "./lib/index.js",
      },
      "./client": {
        types: "./lib/types/client/index.d.ts",
        default: "./lib/client.js",
      },
      "./cordis.patch.yml": "./cordis.patch.yml",
      "./package.json": "./package.json",
    });
  });

  it("declares only the intended published artifacts", () => {
    const files = readPackageFiles();

    expect(files).toEqual([
      "lib/index.js",
      "lib/client.js",
      "lib/client.js.map",
      "lib/types/**/*.d.ts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
      "DESIGN.md",
    ]);

    expect(files).not.toContain("src");
    expect(files).not.toContain("tests");
    expect(files).not.toContain("tests/fixtures");
  });

  it("patches the bundle graph by inserting only this package row", () => {
    const patch = readFileSync(patchPath, "utf8");
    expect(patch).toContain("- insert:");
    expect(patch).toContain("- id: dsh-annotation");
    expect(patch).toMatch(/name:\s+["']dsh-annotation["']/);
    expect(patch).not.toMatch(/^- id:\s+/m);
    expect(patch.match(/^\s{4}-\s+id:\s+/gm) ?? []).toHaveLength(1);
    expect(patch.match(/^\s+name:\s+/gm) ?? []).toHaveLength(1);
  });

  it("exports host and browser entrypoints with explicit inject lists", async () => {
    const host = await import("../src/index.ts");
    const client = await import("../src/client/index.tsx");

    expect(host.inject).toEqual([
      "webServer",
      "storageDomain",
      "sessionPersistence",
      "sessions",
    ]);
    expect(client.inject).toEqual(["slots", "inputTriggers", "sessions"]);
    expect(host.apply).toBeTypeOf("function");
    expect(() => client.apply(undefined as never)).toThrow(
      /slots and inputTriggers/,
    );
  });
});
