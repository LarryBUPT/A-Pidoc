import type { ApiRequest } from "../domain/types.js";

export class RequestPolicy {
  constructor(
    private readonly allowedHosts = new Set(["fixture.local", "localhost", "127.0.0.1"]),
    readonly maxAttempts = 3
  ) {}

  assertAllowed(request: ApiRequest): void {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Blocked protocol: ${url.protocol}`);
    }
    if (!this.allowedHosts.has(url.hostname)) {
      throw new Error(`Blocked host: ${url.hostname}`);
    }
  }
}
