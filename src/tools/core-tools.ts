import { z } from "zod";
import { runSpecialistSubagent, type SubagentRuntimeConfig } from "../kernel/multi-agent.js";
import type { SkillRegistry } from "../kernel/skill-loader.js";
import type { CompletionProposal } from "../kernel/types.js";
import type { HarnessToolSpec, ToolRegistry } from "./registry.js";

/**
 * Harness 核心元工具：
 * 1. load_skill — 渐进式加载 .pi/skills/<name>/SKILL.md
 * 2. read_evidence — 读取历史 Evidence Artifact 完整数据
 * 3. delegate_specialist — 委派隔离上下文只读子 Agent（Multi-Agent）
 * 4. submit_completion — 提交完成提案（交由 EvidenceGate + Independent Reviewer 裁决）
 */
export function createCoreHarnessTools(params: {
  skills: SkillRegistry;
  registry: ToolRegistry;
  subagentRuntime?: SubagentRuntimeConfig;
}): HarnessToolSpec<any>[] {
  const loadSkillSchema = z.object({
    skillName: z.string().min(1).max(80)
  });

  const readEvidenceSchema = z.object({
    evidenceId: z.string().min(1).max(160)
  });

  const delegateSchema = z.object({
    focus: z.string().min(1).max(120),
    question: z.string().min(1).max(1_000)
  });

  const completionSchema = z.object({
    proposal: z.object({
      summary: z.string().min(1).max(1_000),
      rootCause: z.string().min(1).max(300),
      claims: z
        .array(
          z.object({
            statement: z.string().min(1).max(500),
            evidenceIds: z.array(z.string().min(1).max(160)).min(1).max(12)
          })
        )
        .min(1)
        .max(15),
      verifiedHttpIds: z.array(z.string().min(1).max(160)).max(20).optional(),
      migrationArtifacts: z
        .object({
          contractDiffId: z.string().max(160).optional(),
          patchArtifactId: z.string().max(160).optional(),
          testRunId: z.string().max(160).optional(),
          testExitCode: z.number().int().optional()
        })
        .optional(),
      recommendations: z.array(z.string().max(400)).max(10).optional()
    })
  });

  const loadSkillTool: HarnessToolSpec<z.infer<typeof loadSkillSchema>> = {
    name: "load_skill",
    label: "Load Domain Skill",
    description:
      "Load full step-by-step instructions for a registered domain skill from .pi/skills (progressive disclosure).",
    risk: "read",
    jsonSchema: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "Skill name from the Available Domain Skills catalog" }
      },
      required: ["skillName"],
      additionalProperties: false
    },
    zodSchema: loadSkillSchema,
    execute: async (args, context) => {
      const skill = params.skills.get(args.skillName);
      if (!skill) {
        throw new Error(`UNKNOWN_SKILL:${args.skillName}`);
      }
      if (!context.snapshot.loadedSkills.includes(skill.name)) {
        context.snapshot.loadedSkills.push(skill.name);
      }
      return {
        summary: `Loaded skill "${skill.name}"`,
        data: {
          name: skill.name,
          description: skill.description,
          instructions: skill.content
        }
      };
    }
  };

  const readEvidenceTool: HarnessToolSpec<z.infer<typeof readEvidenceSchema>> = {
    name: "read_evidence",
    label: "Read Evidence Artifact",
    description:
      "Inspect the full redacted JSON payload of a previously recorded Evidence Artifact by its ID.",
    risk: "read",
    jsonSchema: {
      type: "object",
      properties: {
        evidenceId: { type: "string", description: "Evidence Artifact ID from the workspace board" }
      },
      required: ["evidenceId"],
      additionalProperties: false
    },
    zodSchema: readEvidenceSchema,
    execute: async (args, context) => {
      const artifact = context.snapshot.evidence.find((item) => item.id === args.evidenceId);
      if (!artifact) {
        throw new Error(`EVIDENCE_NOT_FOUND:${args.evidenceId}`);
      }
      return {
        summary: `Inspected evidence ${artifact.id} (${artifact.kind})`,
        data: artifact
      };
    }
  };

  const submitCompletionTool: HarnessToolSpec<z.infer<typeof completionSchema>> = {
    name: "submit_completion",
    label: "Submit Verified Completion Proposal",
    description:
      "Submit your grounded diagnosis and verification proposal. The host EvidenceGate and Independent Reviewer decide whether the run is resolved.",
    risk: "read",
    jsonSchema: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          properties: {
            summary: { type: "string" },
            rootCause: { type: "string" },
            claims: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  statement: { type: "string" },
                  evidenceIds: { type: "array", items: { type: "string" } }
                },
                required: ["statement", "evidenceIds"]
              }
            },
            verifiedHttpIds: { type: "array", items: { type: "string" } },
            migrationArtifacts: {
              type: "object",
              properties: {
                contractDiffId: { type: "string" },
                patchArtifactId: { type: "string" },
                testRunId: { type: "string" },
                testExitCode: { type: "integer" }
              }
            },
            recommendations: { type: "array", items: { type: "string" } }
          },
          required: ["summary", "rootCause", "claims"]
        }
      },
      required: ["proposal"],
      additionalProperties: false
    },
    zodSchema: completionSchema,
    execute: async (args) => {
      const proposal = args.proposal as CompletionProposal;
      return {
        summary: `Submitted completion proposal with ${proposal.claims.length} grounded claim(s).`,
        data: {
          status: "submitted_for_host_verification",
          proposal
        }
      };
    }
  };

  const tools: HarnessToolSpec<any>[] = [loadSkillTool, readEvidenceTool, submitCompletionTool];

  if (params.subagentRuntime) {
    const runtimeConfig = params.subagentRuntime;
    const delegateTool: HarnessToolSpec<z.infer<typeof delegateSchema>> = {
      name: "delegate_specialist",
      label: "Delegate to Read-Only Specialist Subagent",
      description:
        "Delegate deep OpenAPI or source-code inspection to an isolated read-only Specialist Subagent so large raw documents do not pollute your main context window.",
      risk: "read",
      jsonSchema: {
        type: "object",
        properties: {
          focus: { type: "string", description: "Short topic label, e.g. openapi-orders or repo-impact" },
          question: { type: "string", description: "Specific read-only research question to answer" }
        },
        required: ["focus", "question"],
        additionalProperties: false
      },
      zodSchema: delegateSchema,
      execute: async (args, context) => {
        const result = await runSpecialistSubagent({
          focus: args.focus,
          question: args.question,
          snapshot: context.snapshot,
          registry: params.registry,
          telemetry: context.telemetry,
          runtime: runtimeConfig,
          ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
          ...(context.signal ? { signal: context.signal } : {})
        });

        return {
          summary: `Specialist (${args.focus}) returned brief referencing ${result.evidenceIds.length} evidence artifact(s).`,
          evidenceKind: "specialist_brief",
          data: result
        };
      }
    };
    tools.push(delegateTool);
  }

  return tools;
}
