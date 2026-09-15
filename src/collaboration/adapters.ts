import { randomUUID } from "node:crypto";
import { PublicError } from "../security/errors.js";
import { redactText } from "../security/redaction.js";
import type { CollaborationPlatform, CollaborationSummary, CollaborationWorkItem, PlatformReply } from "./types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError("INVALID_COLLABORATION_PAYLOAD", `${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PublicError("INVALID_COLLABORATION_PAYLOAD", `${label} must be a non-empty string`);
  return redactText(value.trim()).slice(0, 8_192);
}

function number(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new PublicError("INVALID_COLLABORATION_PAYLOAD", `${label} must be a positive integer`);
  return value as number;
}

function optionalCorrelation(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? redactText(value.trim()).slice(0, 256) : null;
}

export function normalizeCollaborationPayload(platform: CollaborationPlatform, payload: unknown, tenantId: string): CollaborationWorkItem {
  if (!tenantId.trim()) throw new PublicError("INVALID_TENANT", "tenantId is required");
  const root = object(payload, `${platform} payload`);
  if (platform === "github") {
    const repository = object(root.repository, "repository"); const pull = object(root.pull_request, "pull_request");
    const resource = text(repository.full_name, "repository.full_name"); const index = number(pull.number ?? root.number, "pull_request.number");
    return { id: `github:${resource}:${index}`, tenantId, platform, kind: "change_request", title: text(pull.title, "pull_request.title"), description: typeof pull.body === "string" ? redactText(pull.body).slice(0, 8_192) : "", resource, replyTarget: String(index), correlationId: optionalCorrelation(root.correlation_id) };
  }
  if (platform === "gitlab") {
    const project = object(root.project, "project"); const merge = object(root.object_attributes, "object_attributes");
    const resource = text(project.path_with_namespace, "project.path_with_namespace"); const index = number(merge.iid, "object_attributes.iid");
    return { id: `gitlab:${resource}:${index}`, tenantId, platform, kind: "change_request", title: text(merge.title, "object_attributes.title"), description: typeof merge.description === "string" ? redactText(merge.description).slice(0, 8_192) : "", resource, replyTarget: String(index), correlationId: optionalCorrelation(root.correlation_id) };
  }
  if (platform === "jira") {
    const issue = object(root.issue, "issue"); const fields = object(issue.fields, "issue.fields"); const key = text(issue.key, "issue.key");
    return { id: `jira:${key}`, tenantId, platform, kind: "issue", title: text(fields.summary, "issue.fields.summary"), description: typeof fields.description === "string" ? redactText(fields.description).slice(0, 8_192) : "", resource: key, replyTarget: key, correlationId: optionalCorrelation(fields.correlationId ?? root.correlation_id) };
  }
  if (platform === "slack") {
    const event = object(root.event, "event"); const team = text(root.team_id, "team_id"); const channel = text(event.channel, "event.channel"); const timestamp = text(event.ts, "event.ts");
    return { id: `slack:${team}:${channel}:${timestamp}`, tenantId, platform, kind: "message", title: `Slack message in ${channel}`, description: text(event.text, "event.text"), resource: team, replyTarget: channel, correlationId: optionalCorrelation(event.thread_ts ?? root.correlation_id) };
  }
  const event = object(root.event, "event"); const message = object(event.message, "event.message"); const chat = text(message.chat_id, "event.message.chat_id"); const id = text(message.message_id, "event.message.message_id");
  let content = "";
  if (typeof message.content === "string") { try { const parsed = object(JSON.parse(message.content), "event.message.content"); content = text(parsed.text, "event.message.content.text"); } catch { content = text(message.content, "event.message.content"); } }
  return { id: `feishu:${chat}:${id}`, tenantId, platform, kind: "message", title: `Feishu message in ${chat}`, description: content, resource: chat, replyTarget: chat, correlationId: optionalCorrelation(root.correlation_id) };
}

function markdown(summary: CollaborationSummary): string {
  return [
    "## A-Pidoc diagnosis",
    `- status: ${summary.status}`,
    `- root cause: ${summary.rootCause}`,
    `- attempts: ${summary.attempts}`,
    `- evidence complete: ${summary.evidenceComplete}`,
    `- related cases: ${summary.relatedCases}`,
    `- log events: ${summary.logEvents}`,
    `- regression test: ${redactText(summary.regressionTest)}`,
    `- result: ${redactText(summary.message)}`
  ].join("\n");
}

export function buildPlatformReply(item: CollaborationWorkItem, summary: CollaborationSummary): PlatformReply {
  const body = markdown(summary);
  switch (item.platform) {
    case "github": return { platform: item.platform, method: "POST", path: `/repos/${item.resource.split("/").map(encodeURIComponent).join("/")}/issues/${encodeURIComponent(item.replyTarget)}/comments`, body: { body } };
    case "gitlab": return { platform: item.platform, method: "POST", path: `/projects/${encodeURIComponent(item.resource)}/merge_requests/${item.replyTarget}/notes`, body: { body } };
    case "jira": return { platform: item.platform, method: "POST", path: `/rest/api/3/issue/${encodeURIComponent(item.replyTarget)}/comment`, body: { body } };
    case "slack": return { platform: item.platform, method: "POST", path: "/api/chat.postMessage", body: { channel: item.replyTarget, text: body } };
    case "feishu": return { platform: item.platform, method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=chat_id", body: { receive_id: item.replyTarget, msg_type: "text", content: JSON.stringify({ text: body }) } };
  }
}

export function fixtureReceipt(item: CollaborationWorkItem, summary: CollaborationSummary) {
  return { id: `fixture-publication:${randomUUID()}`, platform: item.platform, reply: buildPlatformReply(item, summary) };
}
