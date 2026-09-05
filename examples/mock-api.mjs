import { createServer } from "node:http";

const port = Number(process.env.MOCK_API_PORT ?? 3001);

createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method !== "POST" || request.url !== "/orders") {
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "method not allowed: expected POST" }));
    return;
  }
  if (request.headers["content-type"] !== "application/json") {
    response.statusCode = 415;
    response.end(JSON.stringify({ error: "unsupported media type: expected application/json" }));
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof body.amount !== "number") {
        response.statusCode = 422;
        response.end(JSON.stringify({ error: "validation failed", field: "amount", expectedType: "number" }));
        return;
      }
      response.end(JSON.stringify({ ok: true, orderId: "demo-order" }));
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "invalid JSON" }));
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`Mock API listening on http://127.0.0.1:${port}`));
