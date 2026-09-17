import { TrajectoryStore } from "../harness/trajectory-store.js";
import { resolveEvidence, workspaceState } from "./convergent-workspace.js";
import { redactValue } from "../security/redaction.js";
function observation(data:unknown):string {
  const text=JSON.stringify(data);if(text.length<=1024)return text;
  const fields=Object.fromEntries(Object.entries(data as Record<string,unknown>).filter(([_k,v])=>typeof v==="number"||typeof v==="boolean"||typeof v==="string"&&v.length<=160));
  return JSON.stringify({summary:"Large observation; read_evidence contains full data",fields});
}

export class ContextProjector {
  constructor(readonly store: TrajectoryStore, private readonly maxBytes = 32_768) {}
  async project(messages: unknown[]): Promise<unknown[]> {
    try {
      const s = await this.store.load(), state = workspaceState(s), b = s.run.task.budget, u = s.run.usage;
      const board = { goal: s.run.task.goal, stage: state.stage, stateRevision: s.stateRevision, workspaceRevision: s.workspaceRevision, evidenceSequence: s.evidenceSequence,
        remaining: { modelCalls: b.maxModelCalls - u.modelCalls, toolCalls: b.maxToolCalls - u.toolCalls, tokens: b.maxTokens - u.tokens, estimatedCostUsd: b.maxCostUsd - u.estimatedCostUsd },
        evidence: s.run.evidence.slice(-24).map(ref => { const a = resolveEvidence(s, ref.id); return { id: ref.id, kind: ref.kind, sha256: ref.sha256, valid: !!a, inspected: state.inspectedEvidenceIds.includes(ref.id), observation: a ? observation(a.data) : null }; }),
        completionRequirements: s.run.task.taskFamily === "runtime-api" ? "Cite actual failed HTTP baseline and later successful HTTP observation for the registered matching operation; the latest observation must be successful. Monitoring snapshots provide provenance, not HTTP completion IDs. Honor publication requirements in the goal." : "Cite actual diff, impact, approved isolated patch and successful test artifacts. Honor publication requirements in the goal.",
        openHypotheses: state.openHypotheses.slice(0, 8), rejectedHypotheses: state.rejectedHypotheses.slice(-8), noProgressCount: state.noProgressCount,
        pending: s.pendingApproval ? { toolName: s.pendingApproval.toolName, actionDigest: s.pendingApproval.normalizedArgsDigest, status: s.pendingApproval.status } : null,
        reviewFeedback: [...s.run.steps].reverse().find(v => v.kind === "review" && ["revision_requested", "manual_handoff"].includes((v.data as {type?:string}).type ?? ""))?.data ?? null,
        instruction: "Evidence IDs refer to persisted tool results. inspected records a completed full read; repeated unchanged reads do not advance the task. Read details when genuinely needed. Never claim unexecuted changes or tests. Submit a supported proposal when the goal and completion requirements are satisfied; the host Evidence Gate alone validates it." };
      const safe = redactValue(messages) as Array<Record<string, unknown>>;
      const last = safe.at(-1), tail: unknown[] = [];
      if (last?.role === "user" || last?.role === "approval_granted") tail.push(last);
      else if (last?.role === "toolResult") {
        let index = safe.length - 1; while (index >= 0 && safe[index]?.role === "toolResult") index--;
        const assistant = safe[index];
        if (assistant?.role === "assistant") {
          tail.push(assistant);
          for (const m of safe.slice(index + 1)) tail.push({ ...m, content: ["read_evidence", "submit_completion"].includes(String(m.toolName)) && Buffer.byteLength(JSON.stringify(m.content)) <= 8192 ? m.content : [{ type: "text", text: "Observation persisted in the evidence board. Use evidence IDs for details." }], details: undefined });
        }
      }
      const projected = [{ role: "user", timestamp: Date.now(), content: `API WORKSPACE BOARD\n${JSON.stringify(board)}` }, ...tail];
      if (Buffer.byteLength(JSON.stringify(projected)) > this.maxBytes) {
        // Keep approval messages intact; block via adapter's prompt budget if oversized.
        const minimal = { goal: board.goal, stage: state.stage, remaining: board.remaining, completionRequirements: board.completionRequirements, noProgressCount: state.noProgressCount, evidence: s.run.evidence.slice(-24).map(r => ({ id: r.id, kind: r.kind, inspected: state.inspectedEvidenceIds.includes(r.id) })), instruction: "Read persisted evidence by ID if needed; do not repeatedly inspect unchanged artifacts. Never claim success without a passed gate." };
        const approval = last?.role === "approval_granted" ? [last] : [];
        const fallback = [{ role: "user", timestamp: Date.now(), content: JSON.stringify(minimal) }, ...approval];
        return Buffer.byteLength(JSON.stringify(fallback)) <= this.maxBytes ? fallback : [{ role: "user", timestamp: Date.now(), content: "Context budget exhausted. Stop without claiming success; persisted evidence remains available." }];
      }
      return projected;
    } catch { return redactValue(messages) as unknown[]; }
  }
}
