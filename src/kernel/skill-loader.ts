import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SkillDocument {
  name: string;
  description: string;
  filePath: string;
  content: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) meta[key] = value;
  }

  return { meta, body: match[2]!.trim() };
}

/**
 * 渐进式 Skill 加载器（遵循 Pi Agent Progressive Disclosure 理念）：
 * - 启动时只向 System Prompt 暴露技能名称与简短描述（极低 Token 占用）
 * - 运行时模型通过 `load_skill` 工具按需加载完整规程正文
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDocument>();

  async loadFromDirectory(skillsDir = resolve(".pi/skills")): Promise<SkillDocument[]> {
    this.skills.clear();
    let entries;
    try {
      entries = await readdir(skillsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, "SKILL.md");
      try {
        const raw = await readFile(skillFile, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name || entry.name;
        const description = meta.description || `Workflow skill: ${name}`;
        this.skills.set(name, {
          name,
          description,
          filePath: skillFile,
          content: body
        });
      } catch {
        // 忽略无 SKILL.md 的子目录
      }
    }

    return this.list();
  }

  list(): SkillDocument[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillDocument | undefined {
    return this.skills.get(name);
  }

  formatCatalogForPrompt(): string {
    const items = this.list();
    if (items.length === 0) return "";

    const lines = items.map((skill) => `- **${skill.name}**: ${skill.description}`);
    return [
      "## Available Domain Skills (Progressive Disclosure)",
      "Call `load_skill` before executing complex domain workflows to load full procedural instructions:",
      ...lines
    ].join("\n");
  }
}
