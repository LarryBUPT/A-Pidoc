import { fixtureReceipt } from "./adapters.js";
import { PublicError } from "../security/errors.js";
import { redactText, redactValue } from "../security/redaction.js";
import type { CollaborationConnector, CollaborationSummary, CollaborationWorkItem, LogConnector, LogEvent, LogQuery, PublishedReceipt } from "./types.js";

export class FixtureCollaborationConnector implements CollaborationConnector {
  readonly publications: PublishedReceipt[] = [];

  constructor(private readonly item: CollaborationWorkItem) {}

  async read(reference: string): Promise<CollaborationWorkItem> {
    if (reference !== this.item.id) throw new PublicError("WORK_ITEM_NOT_FOUND", "Collaboration work item was not found", 404);
    return structuredClone(this.item);
  }

  async publish(item: CollaborationWorkItem, summary: CollaborationSummary): Promise<PublishedReceipt> {
    const receipt = fixtureReceipt(item, summary); this.publications.push(receipt); return structuredClone(receipt);
  }
}

export class FixtureLogConnector implements LogConnector {
  constructor(private readonly events: LogEvent[], private readonly maxLimit = 50) {}

  async query(input: LogQuery): Promise<LogEvent[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > this.maxLimit) {
      throw new PublicError("LOG_QUERY_LIMIT", `Log query limit must be between 1 and ${this.maxLimit}`, 413);
    }
    return this.events
      .filter((event) => event.tenantId === input.tenantId && event.correlationId === input.correlationId)
      .slice(0, input.limit)
      .map((event) => ({ ...structuredClone(event), message: redactText(event.message), attributes: redactValue(event.attributes) as Record<string, unknown> }));
  }
}
