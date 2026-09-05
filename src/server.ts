import { createServer } from "node:http";
import { createFixtureApp } from "./app.js";
import { getCase } from "./fixtures/cases.js";

const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method === "GET" && request.url === "/health") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/debug") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { caseId?: string };
      if (!input.caseId) throw new Error("caseId is required");
      const report = await createFixtureApp().run(getCase(input.caseId));
      response.statusCode = report.status === "blocked" ? 400 : 200;
      response.end(JSON.stringify(report, null, 2));
      return;
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request" }));
      return;
    }
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, () => console.log(`API Doctor listening on http://localhost:${port}`));
