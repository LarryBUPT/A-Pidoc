import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/harness/tool-registry.js";
import { task, tool } from "./harness-helpers.js";
import { PublicError } from "../src/security/errors.js";

function piTool(registry: ToolRegistry) {
  return registry.toPiTools(task())[0]!;
}

test("ToolRegistry preserves sensitive arguments and oversized output errors", async () => {
  const safe = new ToolRegistry([tool()]);
  await assert.rejects(piTool(safe).execute("call", { password: "never-store-this" }), /SENSITIVE_TOOL_ARGUMENTS/);

  const large = new ToolRegistry([tool("observe", async () => ({ success: true, data: "x".repeat(40_000), evidence: [], warnings: [], durationMs: 0, redacted: true }))]);
  await assert.rejects(piTool(large).execute("call", {}), /TOOL_OUTPUT_TOO_LARGE/);
});

test("ToolRegistry preserves known policy errors from the execution gate", async () => {
  const registry = new ToolRegistry([tool()]);
  const guarded = registry.toPiTools(task(), async () => { throw new Error("EXECUTION_POLICY_CHANGED"); })[0]!;
  await assert.rejects(guarded.execute("call", {}), /EXECUTION_POLICY_CHANGED/);
  const validation = registry.toPiTools(task(), async () => { throw new Error("INVALID_TOOL_EVIDENCE"); })[0]!;
  await assert.rejects(validation.execute("call", {}), /INVALID_TOOL_EVIDENCE/);
});

test("ToolRegistry maps unknown implementation failures to a non-leaking generic error", async () => {
  const registry = new ToolRegistry([tool("observe", async () => { throw new Error("database password=private-secret"); })]);
  let failure: unknown;
  try { await piTool(registry).execute("call", {}); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "TOOL_EXECUTION_FAILED");
  assert.doesNotMatch(String(failure), /private-secret|database password/);
});

test("ToolRegistry preserves safe public error codes without exposing implementation messages", async () => {
  const registry = new ToolRegistry([tool("observe", async () => { throw new PublicError("REQUEST_TIMEOUT", "upstream secret detail", 504); })]);
  await assert.rejects(piTool(registry).execute("call", {}), error => error instanceof Error && error.message === "REQUEST_TIMEOUT" && !String(error).includes("secret"));
});
