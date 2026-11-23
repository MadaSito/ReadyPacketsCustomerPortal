import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");

function preflight(version: string, executable = true) {
  return spawnSync("bash", ["-ec", `
    # Source the actual functions without reading a host's site configuration.
    source <(sed '/^load_site$/d' "$1")
    fixture_node() {
      [[ "$1" == --version ]] || return 64
      printf '%s\\n' "$version"
      [[ "$executable" == true ]]
    }
    version=$2 executable=$3
    require_node_runtime fixture_node
    printf 'preflight passed\\n'
  `, "node-floor-test", resolve(repo, "deploy/lib.sh"), version, String(executable)], { encoding: "utf8" });
}

it.each(["v22.13.0", "v22.13.1", "v22.23.5"])("accepts a supported version %s", (version) => {
  expect(preflight(version)).toMatchObject({ status: 0, stdout: "preflight passed\n" });
});

it.each(["v20.20.2", "v22.12.99", "v22.13.0-rc.1", "v23.0.0", "not Node"])(
  "rejects %s before continuing, with update instructions",
  (version) => {
    expect(preflight(version)).toMatchObject({
      status: 1, stdout: "", stderr: expect.stringContaining("Update fixture_node to Node.js 22.13.0"),
    });
  },
);

it("rejects a runtime that prints a version but exits unsuccessfully", () => {
  expect(preflight("v22.23.5", false)).toMatchObject({ status: 1, stderr: expect.stringContaining("not runnable") });
});

it("keeps the upgrader check before build and drain and the fresh install pin unchanged", () => {
  const upgrade = read("deploy/upgrade.sh");
  expect(upgrade).toMatch(/^check_host\nresolve_release/m);
  const check = upgrade.indexOf("\ncheck_host\n");
  expect(upgrade.indexOf("\nbuild_release\n")).toBeGreaterThan(check);
  expect(upgrade.search(/^ +confirm .* DRAINED$/m)).toBeGreaterThan(check);
  expect(upgrade.indexOf("\nphase=draining\n")).toBeGreaterThan(check);
  const installer = read("deploy/auto-install.sh");
  expect(installer).toMatch(/^readonly node_version=22\.23\.5$/m);
  expect(installer).toContain('node_version_supported "$current"');
  expect(JSON.parse(read("package.json")).engines.node).toBe(">=22.13.0 <23");
});
