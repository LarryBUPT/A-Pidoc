import type { ApiRequest } from "../domain/types.js";

export class RequestPolicy {
  private readonly allowedHosts: Set<string>;

  constructor(
    allowedHosts = new Set(["fixture.local", "localhost", "127.0.0.1"]),
    readonly maxAttempts = 3
  ) {
    this.allowedHosts = new Set([...allowedHosts].map((host) => host.toLowerCase()));
  }

  assertAllowed(request: ApiRequest): void {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Blocked protocol: ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new Error("Blocked credentials embedded in URL");
    }
    if (!this.allowedHosts.has(url.hostname)) {
      throw new Error(`Blocked host: ${url.hostname}`);
    }
  }
}
