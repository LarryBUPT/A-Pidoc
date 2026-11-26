import { buildDemoOpenApiSpec } from "../server/demo-sandbox.js";

export function createDemoOpenApiSpecSafe(baseUrl: string): Record<string, unknown> {
  return buildDemoOpenApiSpec(baseUrl);
}
