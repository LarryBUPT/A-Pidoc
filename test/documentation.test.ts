import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const publicMarkdown = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/guides/getting-started.md",
  "docs/guides/model-setup.md",
  "docs/guides/external-api-benchmark.md",
  "examples/README.md",
  "docs/architecture.md",
  "docs/build-log.md",
  "docs/verification.md"
];

test("public Markdown links resolve to tracked workspace files", async () => {
  for (const file of publicMarkdown) {
    const source = await readFile(resolve(file), "utf8");
    const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].flatMap((match) => match[1] ? [match[1]] : []);
    for (const link of links) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const path = decodeURIComponent(link.replace(/#.*/, ""));
      await assert.doesNotReject(access(resolve(dirname(file), path)), `${file} links to missing ${link}`);
    }
  }
});

test("public docs expose the complete V3 and V4 verification entry points", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const usage = await readFile(resolve("docs/guides/getting-started.md"), "utf8");
  const guide = await readFile(resolve("docs/verification.md"), "utf8");
  assert.match(readme, /\]\(docs\/guides\/getting-started\.md\)/);
  for (const command of ["contract-diff", "contract-impact", "contract-verify", "eval:contract"]) {
    assert.match(usage, new RegExp(command));
    assert.match(guide, new RegExp(command));
  }
  for (const command of ["collaboration-demo", "collaboration-normalize", "postman-import", "postman-export", "eval:collaboration"]) {
    assert.match(usage, new RegExp(command));
    assert.match(guide, new RegExp(command));
  }
  assert.doesNotMatch(readme, /Axios\/自定义客户端/);
});

test("external benchmark docs distinguish runnable assets from live evidence", async () => {
  const assetGuide = await readFile(resolve("benchmarks/external-api/README.md"), "utf8");
  const productGuide = await readFile(resolve("docs/guides/external-api-benchmark.md"), "utf8");
  const verification = await readFile(resolve("docs/verification.md"), "utf8");

  for (const document of [assetGuide, productGuide]) {
    assert.match(document, /Directus[\s\S]*Hurl[\s\S]*Schemathesis[\s\S]*(?:未执行|尚未执行)/);
    assert.doesNotMatch(document, /--network host/);
  }
  assert.match(assetGuide, /--allow-host api\.apis\.guru/);
  for (const chain of ["01-identity-read.hurl", "02-orders-crud.hurl", "03-invalid-token.hurl"]) {
    assert.match(assetGuide, new RegExp(chain.replace(".", "\\.")));
  }
  assert.match(assetGuide, /--secret invalid_token=/);
  assert.match(verification, /benchmark:probe[\s\S]*--allow-host/);
});
