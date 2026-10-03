#!/usr/bin/env node
/**
 * Guard release PRs and the publish workflow.
 *
 * Pull request that changes package.json "version":
 * - package.json and package-lock.json (root and packages[""]) match
 * - CHANGELOG.md has a heading for that version
 * - every "(#N)" already merged to the base branch since the previous tag
 *   appears in that changelog entry; missing numbers are reported one by one
 * - the bump must be a patch, unless the PR is labeled release:minor or release:major
 *
 * Any pull request: if the base branch has those PRs since the previous tag,
 * print a non-blocking GitHub Actions notice. They stay unreleased until a tag.
 *
 * --publish (tag push): the tag equals v<package.json version>, and CHANGELOG.md
 * has an entry for that version.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function runReleaseCheck(cwd, env, argv) {
  const report = createReport();
  try {
    if (argv.includes("--publish")) {
      if (argv.length !== 1) {
        report.error(`Unknown arguments: ${argv.join(" ")}`);
        return report.done(1);
      }
      checkPublish(cwd, env, report);
      return report.done(report.errors ? 1 : 0);
    }
    if (argv.length > 0) {
      report.error(`Unknown arguments: ${argv.join(" ")}`);
      return report.done(1);
    }
    checkPullRequest(cwd, env, report);
    return report.done(report.errors ? 1 : 0);
  } catch (error) {
    report.error(error instanceof Error ? error.message : String(error));
    return report.done(1);
  }
}

function checkPullRequest(cwd, env, report) {
  const headVersion = readPackageVersion(cwd);
  const base = resolveBase(cwd, env);
  const baseVersion = packageVersionAt(cwd, base.ref);
  const unreleased = pullRequestsSinceTag(cwd, base);

  if (env.GITHUB_EVENT_NAME === "pull_request" && unreleased.numbers.length > 0) {
    const since = unreleased.tag ?? "the beginning of history";
    const listed = unreleased.numbers.map((number) => `#${number}`).join(", ");
    report.notice(`Unreleased PRs on ${base.name} since ${since}: ${listed}`);
  }

  if (headVersion === baseVersion) return;

  const lock = readLock(cwd);
  if (lock.version !== headVersion) {
    report.error(
      `package-lock.json version is ${shown(lock.version)}, expected ${headVersion}`,
      "package-lock.json",
    );
  }
  const nested = lock.packages?.[""]?.version;
  if (nested !== headVersion) {
    report.error(
      `package-lock.json packages[""].version is ${shown(nested)}, expected ${headVersion}`,
      "package-lock.json",
    );
  }

  const bump = classifyBump(baseVersion, headVersion);
  const labels = labelsFrom(env);
  if (bump.kind === "invalid") {
    report.error(bump.reason);
  } else if (bump.kind === "minor" && !labels.includes("release:minor")) {
    report.error(`Minor bump ${baseVersion} -> ${headVersion} requires the release:minor label`);
  } else if (bump.kind === "major" && !labels.includes("release:major")) {
    report.error(`Major bump ${baseVersion} -> ${headVersion} requires the release:major label`);
  }

  const markdown = readChangelog(cwd, report);
  const entry = markdown == null ? null : changelogEntry(markdown, headVersion);
  if (markdown != null && entry == null) {
    report.error(`CHANGELOG.md has no entry for ${headVersion}`, "CHANGELOG.md");
  }
  const haystack = entry ?? "";
  for (const number of unreleased.numbers) {
    if (!mentionsPullRequest(haystack, number)) {
      report.error(`Changelog entry for ${headVersion} is missing PR #${number}`, "CHANGELOG.md");
    }
  }
}

function checkPublish(cwd, env, report) {
  const version = readPackageVersion(cwd);
  const tag = env.GITHUB_REF_NAME ?? "";
  if (tag !== `v${version}`) {
    report.error(`Git tag must match package.json version: v${version}`);
  }
  const markdown = readChangelog(cwd, report);
  if (markdown != null && changelogEntry(markdown, version) == null) {
    report.error(`CHANGELOG.md has no entry for ${version}`, "CHANGELOG.md");
  }
}

function pullRequestsSinceTag(cwd, base) {
  const tag = gitOrNull(cwd, ["describe", "--tags", "--abbrev=0", base.ref]);
  const range = tag ? `${tag}..${base.ref}` : base.ref;
  const log = git(cwd, ["log", range, "--format=%B%x1e"]);
  return { tag, numbers: extractPullRequests(log) };
}

function resolveBase(cwd, env) {
  const name =
    [env.BASE_REF, env.GITHUB_BASE_REF, "main"].find((value) => value && value.length > 0) ?? "main";
  for (const ref of [`origin/${name}`, name]) {
    if (gitOrNull(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) != null) {
      return { name, ref };
    }
  }
  throw new Error(`Cannot resolve base ref ${name}`);
}

function readPackageVersion(cwd) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json version must be a non-empty string");
  }
  return parsed.version;
}

function packageVersionAt(cwd, ref) {
  let parsed;
  try {
    parsed = JSON.parse(git(cwd, ["show", `${ref}:package.json`]));
  } catch (error) {
    throw new Error(
      `Cannot read ${ref}:package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${ref}:package.json version must be a non-empty string`);
  }
  return parsed.version;
}

function readLock(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read package-lock.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readChangelog(cwd, report) {
  try {
    return readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
  } catch (error) {
    report.error(
      `CHANGELOG.md is missing: ${error instanceof Error ? error.message : String(error)}`,
      "CHANGELOG.md",
    );
    return null;
  }
}

export function classifyBump(from, to) {
  const previous = parseVersion(from);
  const next = parseVersion(to);
  if (!previous || !next) {
    return {
      kind: "invalid",
      reason: `Cannot classify bump ${from} -> ${to}; versions must be major.minor.patch`,
    };
  }
  if (next.major > previous.major) return { kind: "major" };
  if (next.major === previous.major && next.minor > previous.minor) return { kind: "minor" };
  if (next.major === previous.major && next.minor === previous.minor && next.patch > previous.patch) {
    return { kind: "patch" };
  }
  return {
    kind: "invalid",
    reason: `Version change ${from} -> ${to} is not a patch, minor, or major upgrade`,
  };
}

function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function changelogEntry(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+v?${escapeRegExp(version)}(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function extractPullRequests(text) {
  const found = new Set();
  for (const match of text.matchAll(/\(#(\d+)\)/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((left, right) => left - right);
}

export function mentionsPullRequest(entry, number) {
  return new RegExp(`(?:^|\\D)#${number}(?!\\d)`).test(entry);
}

function labelsFrom(env) {
  return (env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOrNull(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function shown(value) {
  if (value === undefined) return "missing";
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createReport() {
  const out = [];
  const err = [];
  return {
    errors: 0,
    notice(message) {
      out.push(`::notice::${message}`);
    },
    error(message, file) {
      this.errors += 1;
      const target = file ? ` file=${file}` : "";
      out.push(`::error${target}::${message}`);
      err.push(`release-check: ${message}`);
    },
    done(code) {
      return {
        code,
        stdout: out.length > 0 ? `${out.join("\n")}\n` : "",
        stderr: err.length > 0 ? `${err.join("\n")}\n` : "",
      };
    },
  };
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const result = runReleaseCheck(process.cwd(), process.env, process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
