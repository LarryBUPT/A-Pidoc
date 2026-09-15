import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PublicError } from "../security/errors.js";
import { redactText, redactValue } from "../security/redaction.js";
import type { KnowledgeCase, KnowledgeQuery, KnowledgeStore } from "./types.js";

function sanitize(item: KnowledgeCase): KnowledgeCase {
  return {
    ...structuredClone(item),
    errorSignature: redactText(item.errorSignature).slice(0, 512),
    operation: redactText(item.operation).slice(0, 512),
    effectiveFix: redactText(item.effectiveFix).slice(0, 2_048),
    verification: redactText(item.verification).slice(0, 2_048),
    applicableVersion: redactText(item.applicableVersion).slice(0, 128),
    evidenceSources: (redactValue(item.evidenceSources) as string[]).slice(0, 20)
  };
}

function parseCases(value: unknown): KnowledgeCase[] {
  if (!Array.isArray(value)) throw new PublicError("INVALID_KNOWLEDGE_STORE", "Knowledge store must contain an array");
  return value as KnowledgeCase[];
}

export class JsonKnowledgeStore implements KnowledgeStore {
  constructor(private readonly file: string, private readonly maxCases = 1_000) {}

  private async load(): Promise<KnowledgeCase[]> {
    try { return parseCases(JSON.parse(await readFile(this.file, "utf8")) as unknown); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof PublicError) throw error;
      throw new PublicError("INVALID_KNOWLEDGE_STORE", "Knowledge store could not be read safely");
    }
  }

  async findSimilar(query: KnowledgeQuery): Promise<KnowledgeCase[]> {
    const limit = query.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new PublicError("KNOWLEDGE_QUERY_LIMIT", "Knowledge query limit must be between 1 and 20");
    const cases = await this.load();
    return cases.filter((item) => item.tenantId === query.tenantId && item.operation === query.operation && (query.rootCause === undefined || item.rootCause === query.rootCause)).slice(-limit).reverse().map((item) => structuredClone(item));
  }

  async save(input: KnowledgeCase): Promise<void> {
    const cases = await this.load(); const item = sanitize(input); const existing = cases.findIndex((candidate) => candidate.id === item.id && candidate.tenantId === item.tenantId);
    if (existing >= 0) cases[existing] = item; else cases.push(item);
    if (cases.length > this.maxCases) throw new PublicError("KNOWLEDGE_STORE_LIMIT", `Knowledge store exceeds ${this.maxCases} cases`, 413);
    await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(cases, null, 2)}\n`, "utf8"); await rename(temporary, this.file);
  }
}
