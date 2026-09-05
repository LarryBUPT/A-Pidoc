import type { ApiRequest } from "../domain/types.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PublicError } from "./errors.js";

export interface RequestPolicyOptions {
  allowedHosts?: Iterable<string>;
  allowedPorts?: Iterable<number>;
  maxAttempts?: number;
  maxReasonerCalls?: number;
  resolveHost?: (host: string) => Promise<string[]>;
}

function effectivePort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 10 || first === 127 || (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || first === 0;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return false;
}

export class RequestPolicy {
  private readonly allowedHosts: Set<string>;
  private readonly allowedPorts: Set<number>;
  readonly maxAttempts: number;
  readonly maxReasonerCalls: number;
  private readonly resolveHost: (host: string) => Promise<string[]>;

  constructor(options: RequestPolicyOptions = {}) {
    this.allowedHosts = new Set([...(options.allowedHosts ?? ["fixture.local", "localhost", "127.0.0.1"])]
      .map((host) => host.toLowerCase()));
    this.allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxReasonerCalls = options.maxReasonerCalls ?? 2;
    this.resolveHost = options.resolveHost ?? (async (host) =>
      (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address));
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) {
      throw new PublicError("INVALID_POLICY", "maxAttempts must be an integer between 1 and 5");
    }
    if (!Number.isInteger(this.maxReasonerCalls) || this.maxReasonerCalls < 1 || this.maxReasonerCalls > 3) {
      throw new PublicError("INVALID_POLICY", "maxReasonerCalls must be an integer between 1 and 3");
    }
    if ([...this.allowedPorts].some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new PublicError("INVALID_POLICY", "allowed ports must be integers between 1 and 65535");
    }
  }

  assertAllowed(request: ApiRequest): void {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new PublicError("BLOCKED_PROTOCOL", `Blocked protocol: ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new PublicError("EMBEDDED_CREDENTIALS", "Blocked credentials embedded in URL");
    }
    if (!this.allowedHosts.has(url.hostname)) {
      throw new PublicError("BLOCKED_HOST", `Blocked host: ${url.hostname}`);
    }
    const port = effectivePort(url);
    if (!this.allowedPorts.has(port)) {
      throw new PublicError("BLOCKED_PORT", `Blocked port: ${port}`);
    }
  }

  async assertResolvedAddressAllowed(request: ApiRequest): Promise<void> {
    this.assertAllowed(request);
    const host = new URL(request.url).hostname;
    const addresses = isIP(host) ? [host] : await this.resolveHost(host);
    const explicitlyPrivate = host === "localhost" || isIP(host) !== 0;
    if (!explicitlyPrivate && addresses.some((address) => isPrivateAddress(address))) {
      throw new PublicError("BLOCKED_PRIVATE_ADDRESS", "Blocked host resolving to a private network address");
    }
  }
}
