import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ApiRequest } from "./types.js";
import { PublicError } from "./errors.js";

export interface RequestPolicyOptions {
  allowedHosts?: Iterable<string>;
  allowedPorts?: Iterable<number>;
  resolveHost?: (host: string) => Promise<string[]>;
}

const PRIVATE_SUBNETS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10]
] as const) {
  PRIVATE_SUBNETS.addSubnet(network, prefix, "ipv4");
}
PRIVATE_SUBNETS.addAddress("::", "ipv6");
PRIVATE_SUBNETS.addAddress("::1", "ipv6");
PRIVATE_SUBNETS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_SUBNETS.addSubnet("fe80::", 10, "ipv6");

function effectivePort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
  }
  return version !== 0 && PRIVATE_SUBNETS.check(address, version === 4 ? "ipv4" : "ipv6");
}

export class RequestPolicy {
  private readonly allowedHosts: Set<string>;
  private readonly allowedPorts: Set<number>;
  private readonly resolveHost: (host: string) => Promise<string[]>;

  constructor(options: RequestPolicyOptions = {}) {
    this.allowedHosts = new Set(
      [...(options.allowedHosts ?? ["localhost", "127.0.0.1"])].map((host) => host.toLowerCase())
    );
    this.allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
    this.resolveHost =
      options.resolveHost ??
      (async (host) => (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address));

    for (const port of this.allowedPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new PublicError("INVALID_POLICY", `Invalid allowed port: ${port}`);
      }
    }
  }

  assertAllowed(request: ApiRequest): void {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new PublicError("BLOCKED_PROTOCOL", `Blocked protocol: ${parsedUrl.protocol}`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new PublicError("EMBEDDED_CREDENTIALS", "Blocked credentials embedded in URL");
    }
    if (!this.allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
      throw new PublicError("BLOCKED_HOST", `Host "${parsedUrl.hostname}" is not in allowedHosts`);
    }
    const port = effectivePort(parsedUrl);
    if (!this.allowedPorts.has(port)) {
      throw new PublicError("BLOCKED_PORT", `Port ${port} is not in allowedPorts`);
    }
  }

  async assertResolvedAddressAllowed(request: ApiRequest): Promise<void> {
    this.assertAllowed(request);
    const host = new URL(request.url).hostname.toLowerCase();
    const addresses = isIP(host) ? [host] : await this.resolveHost(host);
    const explicitlyLocal = host === "localhost" || isIP(host) !== 0;

    if (!explicitlyLocal && addresses.some((address) => isPrivateAddress(address))) {
      throw new PublicError(
        "BLOCKED_PRIVATE_ADDRESS",
        `Host "${host}" resolved to a private network address`
      );
    }
  }
}
