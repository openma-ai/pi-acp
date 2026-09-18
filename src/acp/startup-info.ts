/**
 * Startup banner for new sessions (mirrors pi's interactive prelude).
 */

import { VERSION as PI_VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import { VERSION } from "../version.ts";

export function buildStartupInfo(session: AgentSession, diagnostics: readonly string[]): string {
  const loader = session.resourceLoader;
  const lines: string[] = [`**pi v${PI_VERSION}** via openma-pi-acp v${VERSION}`, ""];
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`**${title}**`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  section(
    "Context",
    loader.getAgentsFiles().agentsFiles.map((file) => file.path),
  );
  section(
    "Skills",
    loader.getSkills().skills.map((skill) => `${skill.name} (${skill.sourceInfo.source})`),
  );
  section(
    "Prompts",
    session.promptTemplates.map((template) => `/${template.name} (${template.sourceInfo.source})`),
  );
  section(
    "Extensions",
    loader
      .getExtensions()
      .extensions.filter((extension) => extension.hidden !== true)
      .map((extension) =>
        extension.sourceInfo.source === "sdk"
          ? extension.path
          : `${extension.path} (${extension.sourceInfo.source})`,
      ),
  );
  const model = session.model;
  section(
    "Model",
    model !== undefined
      ? [`${model.provider}/${model.id} · thinking ${session.thinkingLevel}`]
      : ["(none selected)"],
  );
  section("Diagnostics", [...diagnostics]);
  return lines.join("\n").trimEnd() + "\n";
}
