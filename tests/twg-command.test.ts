import assert from "node:assert/strict"
import { resolve } from "node:path"
import test from "node:test"
import {
  assertKnownTwgEffects,
  classifyTwgCommand,
  displayTwgCommand,
  parseTwgCommandMetadata,
  validateTwgArguments,
  type TwgCommandMetadata,
} from "../src/twg-command.ts"

function metadata(path: string[], kind: string, opts: Array<{ long: string }> = []): TwgCommandMetadata {
  return parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path, kind, cmd: `twg ${path.join(" ")}`, opts, group: "Native Product Commands" },
    [1],
  )
}

test("classifies explicit and narrowly allowlisted generic reads", () => {
  assert.equal(classifyTwgCommand(["PROJ-1"], metadata(["jira", "workitem", "get"], "resource-get"), "/work").remote, "read")
  assert.equal(classifyTwgCommand([], metadata(["confluence", "space", "me"], "resource"), "/work").remote, "read")
})

test("control-plane commands require approval before read-like heuristics", () => {
  const contract = parseTwgCommandMetadata(
    {
      type: "cmd",
      ver: 1,
      path: ["future", "status"],
      kind: "resource-get",
      cmd: "twg future status",
      group: "Control-Plane Commands",
    },
    [1],
  )
  assert.equal(classifyTwgCommand([], contract, "/work").remote, "control")
})

test("allows only the exact root resolve command as a read", () => {
  assert.equal(classifyTwgCommand(["PROJ-1"], metadata(["resolve"], "resolve"), "/work").remote, "read")
  assert.equal(
    classifyTwgCommand(
      ["--comment-id", "123"],
      metadata(["confluence", "content", "comments", "resolve"], "resource"),
      "/work",
    ).remote,
    "write",
  )
  assert.equal(
    classifyTwgCommand(
      ["--pull-request", "10", "--task", "20"],
      metadata(["bitbucket", "pull-requests", "task", "resolve"], "resource"),
      "/work",
    ).remote,
    "write",
  )
})

test("classifies downloads and explicit output paths as local writes", () => {
  const effects = classifyTwgCommand(
    ["--attachment-id", "123", "--out", "downloads/file.pdf", "--force"],
    metadata(["confluence", "content", "attachments", "download"], "resource", [{ long: "--out" }]),
    "/work",
  )
  assert.equal(effects.remote, "read")
  assert.equal(effects.local, "write")
  assert.deepEqual(effects.paths[0], {
    mode: "write",
    option: "--out",
    path: "downloads/file.pdf",
    absolutePath: resolve("/work", "downloads/file.pdf"),
    overwrite: true,
    argumentIndex: 3,
    inline: false,
  })
})

test("detects short aliases and local output directories from metadata", () => {
  const contract = parseTwgCommandMetadata(
    {
      type: "cmd",
      ver: 1,
      path: ["future", "export"],
      kind: "resource",
      cmd: "twg future export",
      opts: [{ long: "--output-dir", short: "-d", arg: "<directory>", desc: "Local directory to save output" }],
    },
    [1],
  )
  const effects = classifyTwgCommand(["-d", "out"], contract, "/work")
  assert.equal(effects.local, "write")
  assert.equal(effects.paths[0].option, "--output-dir")
})

test("detects upload files, generated result files, and local positional files", () => {
  const upload = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["jira", "workitem", "attachment", "add"], kind: "resource-create", cmd: "twg jira workitem attachment add", opts: [{ long: "--file", arg: "<file>", desc: "File path to upload" }] },
    [1],
  )
  assert.equal(classifyTwgCommand(["--file=--evidence.txt"], upload, "/work").local, "read")

  const benchmark = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["benchmark", "lite"], kind: "benchmark", cmd: "twg benchmark lite", opts: [{ long: "--result-file", arg: "<file>", desc: "Result file" }] },
    [1],
  )
  assert.equal(classifyTwgCommand(["--result-file", "result.json"], benchmark, "/work").local, "read")

  const loom = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["loom", "video", "upload"], kind: "resource-create", cmd: "twg loom video upload", args: [{ name: "file", desc: "Local video file", req: true }] },
    [1],
  )
  const positional = classifyTwgCommand(["--", "-video.mp4"], loom, "/work")
  assert.equal(positional.local, "read")
  assert.equal(positional.paths[0].argumentIndex, 1)
})

test("detects visualize and image local paths", () => {
  const visualize = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["visualize"], kind: "projection", cmd: "twg visualize", opts: [{ long: "--in", arg: "<file>" }, { long: "--out-dir", arg: "<directory>" }] },
    [1],
  )
  const effects = classifyTwgCommand(["--in", "graph.json", "--out-dir", "rendered"], visualize, "/work")
  assert.equal(effects.local, "write")
  assert.deepEqual(effects.paths.map((path) => path.mode), ["read", "write"])

  const image = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["bitbucket", "pull-requests", "comment", "create"], kind: "resource-create", cmd: "twg bitbucket pull-requests comment create", opts: [{ long: "--image", arg: "<file>" }] },
    [1],
  )
  assert.equal(classifyTwgCommand(["--image", "diagram.png"], image, "/work").local, "read")
})

test("handles default local effects, inline visualize JSON, and clipboard reads", () => {
  const visualize = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["visualize"], kind: "projection", cmd: "twg visualize", args: [{ name: "input", desc: "Graph JSON file path or inline JSON" }] },
    [1],
  )
  const inline = classifyTwgCommand(['{"nodes":[]}'], visualize, "/work")
  assert.equal(inline.local, "write")
  assert.deepEqual(inline.paths.map((path) => path.mode), ["write"])

  const contributors = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["bitbucket", "repo", "contributors"], kind: "resource", cmd: "twg bitbucket repo contributors" },
    [1],
  )
  const checkout = classifyTwgCommand([], contributors, "/work")
  assert.equal(checkout.remote, "read")
  assert.equal(checkout.local, "read")

  const clipboard = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["future", "create"], kind: "resource-create", cmd: "twg future create", opts: [{ long: "--from-clipboard" }] },
    [1],
  )
  assert.equal(classifyTwgCommand(["--from-clipboard"], clipboard, "/work").local, "read")
})

test("recognizes only advertised dry runs", () => {
  assert.equal(
    classifyTwgCommand(
      ["123", "--dry-run"],
      metadata(["confluence", "content", "update"], "resource-update", [{ long: "--dry-run" }]),
      "/work",
    ).remote,
    "read",
  )
  assert.equal(classifyTwgCommand(["--dry-run"], metadata(["future", "command"], "resource"), "/work").remote, "unknown")
})

test("fails closed when a remote effect cannot be proven", () => {
  const contract = metadata(["future", "command"], "resource")
  const effects = classifyTwgCommand([], contract, "/work")
  assert.throws(() => assertKnownTwgEffects(effects, contract), /refusing to execute/)
})

test("Jira transition discovery is read-only only without a transition id", () => {
  const contract = metadata(["jira", "workitem", "transition"], "resource")
  assert.equal(classifyTwgCommand(["--id", "PROJ-1"], contract, "/work").remote, "read")
  assert.equal(
    classifyTwgCommand(["--id", "PROJ-1", "--transition-id=31"], contract, "/work").remote,
    "write",
  )
})

test("rejects unsupported metadata versions", () => {
  assert.throws(
    () => parseTwgCommandMetadata({ type: "cmd", ver: 2, path: ["future"], kind: "resource", cmd: "twg future" }, [1]),
    /Unsupported TWG help contract version 2/,
  )
})

test("validates options and positionals against the exact command contract", () => {
  const contract = parseTwgCommandMetadata(
    {
      type: "cmd",
      ver: 1,
      path: ["jira", "workitem", "get"],
      kind: "resource-get",
      cmd: "twg jira workitem get",
      args: [{ name: "key", req: true }],
      opts: [{ long: "--fields", short: "-f", arg: "<fields>" }, { long: "--hydrate" }],
    },
    [1],
  )
  assert.doesNotThrow(() => validateTwgArguments(["PROJ-1", "-f", "summary,status", "--hydrate"], contract))
  assert.doesNotThrow(() => validateTwgArguments(["PROJ-1", "--site", "example", "--output", "json", "--select", "data.issues.key"], contract))
  assert.doesNotThrow(() => validateTwgArguments(["PROJ-1", "--output-summary", "--api-version", "v3", "--timeout-ms", "1000", "--output-shape", "rows"], contract))
  assert.throws(() => validateTwgArguments(["PROJ-1", "--unknown"], contract), /not declared/)
  assert.throws(() => validateTwgArguments(["PROJ-1", "--fields", "--undeclared"], contract), /requires/)
  assert.throws(() => validateTwgArguments(["PROJ-1", "--fields"], contract), /requires/)
  assert.throws(() => validateTwgArguments([], contract), /requires at least 1/)
  assert.throws(() => validateTwgArguments(["PROJ-1", "extra"], contract), /at most 1/)
})

test("accepts variadic option values declared by the live contract", () => {
  const contract = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["bitbucket", "pull-requests", "create"], kind: "resource-create", cmd: "twg bitbucket pull-requests create", opts: [{ long: "--reviewer", arg: "<reviewer...>", vari: true }] },
    [1],
  )
  assert.doesNotThrow(() => validateTwgArguments(["--reviewer", "one", "two"], contract))
})

test("records every path from a variadic local option", () => {
  const contract = parseTwgCommandMetadata(
    { type: "cmd", ver: 1, path: ["future", "upload"], kind: "resource-create", cmd: "twg future upload", opts: [{ long: "--file", arg: "<file...>", vari: true }] },
    [1],
  )
  const effects = classifyTwgCommand(["--file", "one.txt", "two.txt"], contract, "/work")
  assert.deepEqual(effects.paths.map((path) => path.path), ["one.txt", "two.txt"])
  const inline = classifyTwgCommand(["--file=one.txt", "two.txt"], contract, "/work")
  assert.deepEqual(inline.paths.map((path) => path.path), ["one.txt", "two.txt"])
})

test("redacts and bounds approval command displays", () => {
  const display = displayTwgCommand(
    ["jira", "workitem", "create"],
    ["--summary", "Short", "--description", "secret body", "--variables-json={\"token\":\"secret\"}"],
  )
  assert.match(display, /--description <redacted>/)
  assert.match(display, /--variables-json=<redacted>/)
  assert.doesNotMatch(display, /secret body|token/)
  assert.ok(displayTwgCommand(["x"], ["a".repeat(2_000)]).length <= 1_000)
})
