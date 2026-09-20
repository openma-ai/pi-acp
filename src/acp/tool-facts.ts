/**
 * Tool-call classification shared by live projection and history replay (pure).
 */

import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { isAbsolute, resolve as resolvePath } from "node:path";

const MAX_TITLE_LENGTH = 80;

export interface ToolCallFacts {
  kind: ToolKind;
  title: string;
  locations: ToolCallLocation[];
}

export function firstLine(text: string, limit = MAX_TITLE_LENGTH): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function toolPath(args: unknown): string | undefined {
  const record = asRecord(args);
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function absoluteToolPath(args: unknown, cwd: string): string | undefined {
  const path = toolPath(args);
  if (path === undefined) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

export function isShellTool(name: string): boolean {
  return name === "bash" || name === "powershell";
}

export function isFileMutationTool(name: string): boolean {
  return name === "edit" || name === "write";
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Split `mcp__<server>__<tool>` into its parts. */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!isMcpTool(name)) return undefined;
  const rest = name.slice("mcp__".length);
  const index = rest.indexOf("__");
  if (index <= 0) return undefined;
  return { server: rest.slice(0, index), tool: rest.slice(index + 2) };
}

export function classifyToolCall(name: string, args: unknown, cwd: string, line?: number): ToolCallFacts {
  const record = asRecord(args);
  const absPath = absoluteToolPath(record, cwd);
  const displayPath = toolPath(record);
  const locations: ToolCallLocation[] =
    absPath !== undefined ? [{ path: absPath, ...(line !== undefined ? { line } : {}) }] : [];
  const facts = (kind: ToolKind, title: string): ToolCallFacts => ({ kind, title, locations });

  switch (name) {
    case "bash":
    case "powershell": {
      const command = asString(record["command"]);
      return facts("execute", command !== undefined ? firstLine(command) : name);
    }
    case "read":
      return facts("read", displayPath !== undefined ? `Read ${displayPath}` : "Read file");
    case "write":
      return facts("edit", displayPath !== undefined ? `Write ${displayPath}` : "Write file");
    case "edit":
      return facts("edit", displayPath !== undefined ? `Edit ${displayPath}` : "Edit file");
    case "grep": {
      const pattern = asString(record["pattern"]);
      return facts("search", pattern !== undefined ? `Search for '${firstLine(pattern, 50)}'` : "Search");
    }
    case "find": {
      const pattern = asString(record["pattern"]);
      return facts("search", pattern !== undefined ? `Find ${firstLine(pattern, 50)}` : "Find files");
    }
    case "ls":
      return facts("search", displayPath !== undefined ? `List ${displayPath}` : "List directory");
    case "update_plan":
      return facts("think", "Update plan");
    default:
      break;
  }

  const mcp = parseMcpToolName(name);
  const lowered = (mcp?.tool ?? name).toLowerCase();
  const label = mcp !== undefined ? `${mcp.server}: ${mcp.tool}` : name;
  if (/(^|_)(grep|glob|find|search|ls|list)($|_)/.test(lowered)) {
    const query = asString(record["query"]) ?? asString(record["pattern"]);
    return facts("search", query !== undefined ? `${label} '${firstLine(query, 50)}'` : label);
  }
  if (/(fetch|web|http|browse|url)/.test(lowered)) {
    const url = asString(record["url"]) ?? asString(record["query"]);
    return facts("fetch", url !== undefined ? `${label} ${firstLine(url, 60)}` : label);
  }
  if (/(delete|remove|rm)($|_)/.test(lowered)) return facts("delete", label);
  if (/(move|rename|mv)($|_)/.test(lowered)) return facts("move", label);
  if (/(think|plan|todo|reason)/.test(lowered)) return facts("think", label);
  if (/(job|task|run|exec|shell|command)/.test(lowered)) return facts("execute", label);
  return facts("other", label);
}

/** Text content of a pi tool result (`{content:[{type:"text"}], details}`), joined. */
export function toolResultText(result: unknown): string {
  const record = asRecord(result);
  const content = record["content"];
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b["type"] === "text" && typeof b["text"] === "string") texts.push(b["text"]);
  }
  return texts.join("");
}

export interface ToolResultImage {
  data: string;
  mimeType: string;
}

export function toolResultImages(result: unknown): ToolResultImage[] {
  const record = asRecord(result);
  const content = record["content"];
  if (!Array.isArray(content)) return [];
  const images: ToolResultImage[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b["type"] === "image" && typeof b["data"] === "string" && typeof b["mimeType"] === "string") {
      images.push({ data: b["data"], mimeType: b["mimeType"] });
    }
  }
  return images;
}

/** 1-based line of a unique `needle` occurrence, or undefined when absent/ambiguous. */
export function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (needle.length === 0) return undefined;
  const first = text.indexOf(needle);
  if (first < 0) return undefined;
  if (text.indexOf(needle, first + needle.length) >= 0) return undefined;
  let line = 1;
  for (let i = 0; i < first; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** `oldText` needles from pi's edit input (`{ path, edits: [{oldText,newText}] }`, legacy top-level too). */
export function editOldTexts(args: unknown): string[] {
  const record = asRecord(args);
  const out: string[] = [];
  if (typeof record["oldText"] === "string") out.push(record["oldText"]);
  let edits: unknown = record["edits"];
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = asRecord(edit)["oldText"];
      if (typeof oldText === "string" && !out.includes(oldText)) out.push(oldText);
    }
  }
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Line counts for a change. Lines are matched as a multiset (moves count as
 * remove + add), which is O(n) and matches what review UIs display for
 * add/delete badges closely enough.
 */
export function diffStats(oldText: string | null, newText: string): DiffStats {
  const split = (text: string): string[] => (text.length === 0 ? [] : text.replace(/\n$/, "").split("\n"));
  const newLines = split(newText);
  if (oldText === null) return { added: newLines.length, removed: 0 };
  const oldLines = split(oldText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added += 1;
  }
  let removed = 0;
  for (const remaining of counts.values()) removed += remaining;
  return { added, removed };
}

export function fenceShellOutput(text: string): string {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed.length === 0 ? "" : `\`\`\`sh\n${trimmed}\n\`\`\`\n`;
}
