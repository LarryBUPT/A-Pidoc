import type { ApiRequest, HttpMethod } from "../domain/types.js";

const SUPPORTED_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }

  if (escaping || quote) throw new Error("Invalid curl command: unterminated escape or quote");
  if (token) tokens.push(token);
  return tokens;
}

function requiredValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}`);
  return value;
}

function parseBody(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Only JSON request bodies are supported");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("The JSON request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function parseCurl(command: string): ApiRequest {
  const tokens = tokenize(command);
  if (tokens[0]?.toLowerCase() !== "curl") throw new Error("Input must start with curl");

  let method: HttpMethod | undefined;
  let url: string | undefined;
  let rawBody: string | undefined;
  const headers: Record<string, string> = {};

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "-X" || token === "--request") {
      const candidate = requiredValue(tokens, index, token).toUpperCase() as HttpMethod;
      if (!SUPPORTED_METHODS.has(candidate)) throw new Error(`Unsupported HTTP method: ${candidate}`);
      method = candidate;
      index += 1;
    } else if (token === "-H" || token === "--header") {
      const header = requiredValue(tokens, index, token);
      const separator = header.indexOf(":");
      if (separator <= 0) throw new Error(`Invalid header: ${header}`);
      headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim();
      index += 1;
    } else if (["-d", "--data", "--data-raw", "--data-binary"].includes(token)) {
      rawBody = requiredValue(tokens, index, token);
      index += 1;
    } else if (token === "--url") {
      url = requiredValue(tokens, index, token);
      index += 1;
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      url = token;
    } else if (token.startsWith("-")) {
      throw new Error(`Unsupported curl option: ${token}`);
    }
  }

  if (!url) throw new Error("Curl command does not contain an HTTP(S) URL");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  return {
    method: method ?? (rawBody === undefined ? "GET" : "POST"),
    url: parsedUrl.toString(),
    headers,
    body: rawBody === undefined ? null : parseBody(rawBody)
  };
}
