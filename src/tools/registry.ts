import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ZodType } from "zod";
import { sha256Digest } from "../shared/digest.js";
import { redactValue } from "../shared/redaction.js";
import type { EvidenceArtifact, ToolRiskLevel } from "../shared/types.js";
import type { TelemetryCollector } from "../kernel/telemetry.js";
import type { RunSnapshot } from "../kernel/types.js";

export interface ToolExecutionContext {
  toolCallId: string;
  snapshot: RunSnapshot;
  telemetry: TelemetryCollector;
  parentSpanId?: string;
  signal?: AbortSignal;
}

export interface ToolExecutionOutput {
  summary: string;
  data: unknown;
  evidenceKind?: string;
}

export interface HarnessToolSpec<TInput = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  risk: ToolRiskLevel;
  jsonSchema: Record<string, unknown>;
  zodSchema: ZodType<TInput>;
  execute: (args: TInput, context: ToolExecutionContext) => Promise<ToolExecutionOutput>;
}

/**
 * 统一工具注册表：
 * - 集中管理所有 Agent Tools 及其风险等级（read / network_read / network_write / write）
 * - 执行前通过 Zod 做强类型参数校验
 * - 执行后统一脱敏并生成带 SHA-256 指纹的不可篡改 EvidenceArtifact
 */
export class ToolRegistry {
  private readonly tools = new Map<string, HarnessToolSpec<any>>();

  register<TInput>(spec: HarnessToolSpec<TInput>): this {
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name: string): HarnessToolSpec<any> | undefined {
    return this.tools.get(name);
  }

  list(): HarnessToolSpec<any>[] {
    return [...this.tools.values()];
  }

  toPiTools(options: {
    snapshot: RunSnapshot;
    telemetry: TelemetryCollector;
    parentSpanId?: string;
    allowedRisks?: ToolRiskLevel[];
    excludeTools?: string[];
  }): AgentTool<any>[] {
    const excludeSet = new Set(options.excludeTools ?? []);
    const riskSet = options.allowedRisks ? new Set(options.allowedRisks) : null;

    return this.list()
      .filter((spec) => !excludeSet.has(spec.name) && (!riskSet || riskSet.has(spec.risk)))
      .map((spec): AgentTool<TSchema> => ({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.jsonSchema as unknown as TSchema,
        executionMode: "sequential",
        execute: async (
          toolCallId: string,
          rawParams: unknown,
          signal?: AbortSignal
        ): Promise<AgentToolResult<unknown>> => {
          const parsed = spec.zodSchema.safeParse(rawParams ?? {});
          if (!parsed.success) {
            throw new Error(
              `INVALID_TOOL_ARGS(${spec.name}): ${parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
                .join("; ")}`
            );
          }

          const output = await spec.execute(parsed.data, {
            toolCallId,
            snapshot: options.snapshot,
            telemetry: options.telemetry,
            ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
            ...(signal ? { signal } : {})
          });

          const redactedData = redactValue(output.data);
          let artifact: EvidenceArtifact | undefined;

          if (output.evidenceKind) {
            const safeCallId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "call";
            artifact = {
              id: `${output.evidenceKind}_${safeCallId}_${options.snapshot.evidence.length + 1}`,
              kind: output.evidenceKind,
              toolCallId,
              toolName: spec.name,
              sha256: sha256Digest(redactedData),
              createdAt: new Date().toISOString(),
              summary: output.summary,
              data: redactedData
            };
            options.snapshot.evidence.push(artifact);
            options.telemetry.emit("evidence_recorded", {
              id: artifact.id,
              kind: artifact.kind,
              toolName: artifact.toolName,
              sha256: artifact.sha256,
              summary: artifact.summary
            });
          }

          const modelFacingPayload = {
            summary: output.summary,
            ...(artifact ? { evidenceId: artifact.id, evidenceKind: artifact.kind } : {}),
            data: redactedData
          };

          return {
            content: [{ type: "text", text: JSON.stringify(modelFacingPayload, null, 2) }],
            details: modelFacingPayload
          };
        }
      }));
  }
}
