import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const publicMarkdown = [
  "README.md",
  "CONTRIBUTING.md",
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

test("public docs expose the complete V3 verification entry points", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const guide = await readFile(resolve("docs/verification.md"), "utf8");
  for (const command of ["contract-diff", "contract-impact", "contract-verify", "eval:contract"]) {
    assert.match(readme, new RegExp(command));
    assert.match(guide, new RegExp(command));
  }
  assert.doesNotMatch(readme, /Axios\/自定义客户端/);
});
