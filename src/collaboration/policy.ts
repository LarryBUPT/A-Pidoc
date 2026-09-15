import { PublicError } from "../security/errors.js";
import type { CollaborationActor, CollaborationPermission, CollaborationWorkItem } from "./types.js";

const ROLE_PERMISSIONS: Record<CollaborationActor["role"], ReadonlySet<CollaborationPermission>> = {
  viewer: new Set(["read_item"]),
  operator: new Set(["read_item", "read_logs", "run_diagnosis"]),
  reviewer: new Set(["read_item", "read_logs", "run_diagnosis", "publish_report", "save_knowledge"]),
  admin: new Set(["read_item", "read_logs", "run_diagnosis", "publish_report", "save_knowledge"])
};

export class CollaborationPolicy {
  assertPermission(actor: CollaborationActor, permission: CollaborationPermission): void {
    if (!ROLE_PERMISSIONS[actor.role].has(permission)) {
      throw new PublicError("COLLABORATION_PERMISSION_DENIED", `${actor.role} cannot ${permission}`, 403);
    }
  }

  assertTenant(actor: CollaborationActor, item: CollaborationWorkItem): void {
    if (actor.tenantId !== item.tenantId) {
      throw new PublicError("COLLABORATION_TENANT_MISMATCH", "Work item belongs to another tenant", 403);
    }
  }

  assertApproved(approved: boolean, action: "publish" | "save knowledge"): void {
    if (!approved) throw new PublicError("COLLABORATION_APPROVAL_REQUIRED", `Explicit approval is required to ${action}`, 403);
  }
}
