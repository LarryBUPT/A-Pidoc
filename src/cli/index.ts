import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runEvaluationSuite } from "../eval/runner.js";
import { startMcpStdioServer } from "../mcp/server.js";
import { startHttpServer } from "../server/app.js";
import { RunManager } from "../server/run-manager.js";

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i]!;
    if (!current.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(current.slice(2), next);
      i += 1;
    } else {
      flags.set(current.slice(2), "true");
    }
  }
  return { command, flags };
}

function printHelp(): void {
  console.log(
    [
      "A-Pidoc v2 — Pi-powered Agent Harness for API Debugging & Contract Verification",
      "",
      "Usage:",
      "  a-pidoc serve [--port 3000] [--host 127.0.0.1]       Start Hono REST/SSE server & Vue workbench",
      "  a-pidoc run --goal <text> [--openapi file] [--mode mock|live]",
      "  a-pidoc mcp                                          Start stdio MCP server",
      "  a-pidoc eval [--mode offline|live]                   Run Raw Pi vs Harness Pi benchmark"
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === "serve") {
    const port = Number(flags.get("port") ?? process.env.PORT ?? 3000);
    const host = flags.get("host") ?? "127.0.0.1";
    await startHttpServer({ port, host });
    return;
  }

  if (command === "mcp") {
    await startMcpStdioServer();
    return;
  }

  if (command === "eval") {
    const mode = flags.get("mode") === "live" ? "live" : "offline";
    const report = await runEvaluationSuite({ mode });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const goal = flags.get("goal");
    if (!goal) {
      throw new Error("--goal is required. Example: npm run cli -- run --goal \"Diagnose POST /orders\"");
    }
    const mode = flags.get("mode") === "live" ? "live" : "mock";
    const openApiFile = flags.get("openapi");
    const openApiDocument = openApiFile ? await readFile(resolve(openApiFile), "utf8") : undefined;

    // 启动临时本地靶场端口，确保内置演示也可直接 CLI 运行
    const { server, port } = await startHttpServer({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const manager = new RunManager(baseUrl);
      await manager.initialize();
      const { runId } = await manager.startRun({
        goal,
        mode,
        ...(openApiDocument !== undefined ? { openApiDocument } : {})
      });

      // 轮询等待完成或挂起审批
      for (;;) {
        const snapshot = await manager.store.loadSnapshot(runId);
        if (snapshot && snapshot.status !== "running") {
          console.log(JSON.stringify(snapshot, null, 2));
          if (snapshot.status !== "resolved") process.exitCode = 1;
          break;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
    } finally {
      server.close();
    }
    return;
  }

  printHelp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
