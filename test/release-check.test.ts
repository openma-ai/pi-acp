import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/release-check.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release-check", () => {
  it("accepts a patch bump whose changelog names every PR since the tag", () => {
    const cwd = repoWithPullRequests();
    release(cwd, "0.1.6", "- Message ids (#6).\n- Model defaults (#5).\n");

    const result = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("::notice::Unreleased PRs on main since v0.1.5: #5, #6\n");
    expect(result.stdout).not.toContain("::error");
  });

  it("fails when a changelog entry omits a merged PR", () => {
    const cwd = repoWithPullRequests();
    release(cwd, "0.1.6", "- Model defaults (#5).\n");

    const result = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("release-check: Changelog entry for 0.1.6 is missing PR #6");
    expect(result.stdout).toContain("::error file=CHANGELOG.md::Changelog entry for 0.1.6 is missing PR #6");
    expect(result.stderr).not.toContain("missing PR #5");
  });

  it("ignores PR numbers outside the new entry and longer numbers", () => {
    const cwd = repoWithPullRequests();
    release(cwd, "0.1.6", "- See #50 and #5.\n", "## 0.1.5 — 2026-10-02\n\n- Already shipped (#6).\n");

    const result = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("missing PR #6");
    expect(result.stderr).not.toContain("missing PR #5");
    expect(result.stderr).not.toContain("missing PR #50");
  });

  it("requires package.json and both package-lock versions to match", () => {
    const rootMismatch = repoWithPullRequests();
    release(rootMismatch, "0.1.6", "- Notes (#5) (#6).\n", undefined, { root: "0.1.5", nested: "0.1.6" });
    const rootResult = run(rootMismatch, { GITHUB_EVENT_NAME: "pull_request" });
    expect(rootResult.code).toBe(1);
    expect(rootResult.stderr).toContain('package-lock.json version is "0.1.5", expected 0.1.6');
    expect(rootResult.stderr).not.toContain('packages[""].version');

    const nestedMismatch = repoWithPullRequests();
    release(nestedMismatch, "0.1.6", "- Notes (#5) (#6).\n", undefined, { root: "0.1.6", nested: "0.1.5" });
    const nestedResult = run(nestedMismatch, { GITHUB_EVENT_NAME: "pull_request" });
    expect(nestedResult.code).toBe(1);
    expect(nestedResult.stderr).toContain(
      'package-lock.json packages[""].version is "0.1.5", expected 0.1.6',
    );
  });

  it("allows only a patch bump unless the PR has the matching release label", () => {
    const minor = repoWithPullRequests();
    release(minor, "0.2.0", "- Notes (#5) (#6).\n");
    expect(run(minor, { GITHUB_EVENT_NAME: "pull_request" }).stderr).toContain(
      "Minor bump 0.1.5 -> 0.2.0 requires the release:minor label",
    );
    expect(run(minor, { GITHUB_EVENT_NAME: "pull_request", PR_LABELS: "release:major" }).stderr).toContain(
      "requires the release:minor label",
    );
    expect(run(minor, { GITHUB_EVENT_NAME: "pull_request", PR_LABELS: "other,release:minor" }).code).toBe(0);

    const major = repoWithPullRequests();
    release(major, "1.0.0", "- Notes (#5) (#6).\n");
    expect(run(major, { GITHUB_EVENT_NAME: "pull_request", PR_LABELS: "release:minor" }).stderr).toContain(
      "Major bump 0.1.5 -> 1.0.0 requires the release:major label",
    );
    expect(run(major, { GITHUB_EVENT_NAME: "pull_request", PR_LABELS: "release:major" }).code).toBe(0);

    const downgrade = repoWithPullRequests();
    release(downgrade, "0.1.4", "- Notes (#5) (#6).\n");
    expect(run(downgrade, { GITHUB_EVENT_NAME: "pull_request" }).stderr).toContain(
      "Version change 0.1.5 -> 0.1.4 is not a patch, minor, or major upgrade",
    );
  });

  it("notices unreleased PRs without failing when the version is unchanged", () => {
    const cwd = repoWithPullRequests();
    const result = run(cwd, { GITHUB_EVENT_NAME: "pull_request" });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Unreleased PRs on main since v0.1.5: #5, #6");
    expect(result.stdout).not.toContain("::error");

    const quiet = releasedRepo();
    const quietResult = run(quiet, { GITHUB_EVENT_NAME: "pull_request" });
    expect(quietResult.code).toBe(0);
    expect(quietResult.stdout).not.toContain("::notice");
  });

  it("checks the tag and changelog entry before publish", () => {
    const cwd = repoWithPullRequests();
    release(cwd, "0.1.6", "- Notes (#5) (#6).\n");

    const mismatch = run(cwd, { GITHUB_REF_NAME: "v0.1.5" }, ["--publish"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("Git tag must match package.json version: v0.1.6");

    const missing = repoWithPullRequests();
    release(missing, "0.1.6", "- Notes (#5) (#6).\n");
    writeFileSync(join(missing, "CHANGELOG.md"), "# Changelog\n\n## 0.1.5 — 2026-10-02\n\n- Previous.\n");
    const missingResult = run(missing, { GITHUB_REF_NAME: "v0.1.6" }, ["--publish"]);
    expect(missingResult.code).toBe(1);
    expect(missingResult.stderr).toContain("CHANGELOG.md has no entry for 0.1.6");

    expect(run(cwd, { GITHUB_REF_NAME: "v0.1.6" }, ["--publish"]).code).toBe(0);
  });
});

function run(cwd: string, extra: Record<string, string>, args: string[] = []) {
  const env = { ...process.env };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_BASE_REF;
  delete env.BASE_REF;
  delete env.PR_LABELS;
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function releasedRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-acp-release-"));
  roots.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  writePackage(cwd, "0.1.5");
  writeFileSync(join(cwd, "CHANGELOG.md"), "# Changelog\n\n## 0.1.5 — 2026-10-02\n\n- Previous.\n");
  commitAll(cwd, "Release 0.1.5 (#4)");
  git(cwd, ["tag", "v0.1.5"]);
  return cwd;
}

function repoWithPullRequests() {
  const cwd = releasedRepo();
  writeFileSync(join(cwd, "feature.txt"), "one\n");
  commitAll(cwd, "feat: one (#5)");
  writeFileSync(join(cwd, "feature.txt"), "two\n");
  commitAll(cwd, "chore: internal note");
  writeFileSync(join(cwd, "feature.txt"), "three\n");
  commitAll(cwd, "feat: two (#6)");
  return cwd;
}

function release(
  cwd: string,
  version: string,
  body: string,
  previous = "## 0.1.5 — 2026-10-02\n\n- Previous.\n",
  lock = { root: version, nested: version },
) {
  git(cwd, ["checkout", "-b", "release"]);
  writePackage(cwd, version, lock);
  writeFileSync(
    join(cwd, "CHANGELOG.md"),
    `# Changelog\n\n## ${version} — 2026-10-03\n\n${body}\n${previous}`,
  );
  commitAll(cwd, `Release ${version}`);
}

function writePackage(cwd: string, version: string, lock = { root: version, nested: version }) {
  writeFileSync(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "@openma/pi-acp", version }, null, 2)}\n`,
  );
  writeFileSync(
    join(cwd, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "@openma/pi-acp",
        version: lock.root,
        lockfileVersion: 3,
        packages: { "": { name: "@openma/pi-acp", version: lock.nested } },
      },
      null,
      2,
    )}\n`,
  );
}

function commitAll(cwd: string, message: string) {
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.email=release-check@example.com",
    "-c",
    "user.name=release-check",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
