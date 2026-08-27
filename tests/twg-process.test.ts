import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { extractTwgOutputFiles, runProcess, TwgArtifactStore } from "../src/twg-process.ts"

test("extracts registered TWG output paths from agent summaries", () => {
  assert.deepEqual(
    extractTwgOutputFiles('output_files:\n  stdout: "C:\\\\Temp\\\\stdout.json"\n  compact: "/tmp/compact.json"\ncommand: test'),
    [
      { kind: "stdout", path: "C:\\Temp\\stdout.json" },
      { kind: "compact", path: "/tmp/compact.json" },
    ],
  )
})

test("spools oversized subprocess output instead of killing the process", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-process-test-"))
  try {
    const result = await runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(8192))'], {
      timeoutMs: 10_000,
      inlineLimit: 1024,
      artifactRoot: root,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.bytes, 8192)
    assert.ok(result.stdout.path)
    assert.equal((await readFile(result.stdout.path!, "utf8")).length, 8192)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports subprocess timeouts structurally", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 50 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.exitCode, 0)
})

test("does not spawn when cancellation already occurred", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runProcess(process.execPath, ["-e", "process.exit(99)"], {
    timeoutMs: 10_000,
    signal: controller.signal,
  })
  assert.equal(result.aborted, true)
  assert.equal(result.durationMs, 0)
  assert.equal(result.exitCode, null)
})

test("timeout terminates descendant processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-process-tree-test-"))
  const marker = join(root, "descendant-ran.txt")
  const childScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 800)`
  const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {stdio:"ignore"}); setInterval(() => {}, 1000)`
  try {
    const result = await runProcess(process.execPath, ["-e", parentScript], { timeoutMs: 100 })
    assert.equal(result.timedOut, true)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
    await assert.rejects(access(marker))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact reads are session-scoped and support bounded JSON projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-artifact-test-"))
  const path = join(root, "artifact.json")
  const store = new TwgArtifactStore()
  try {
    await writeFile(path, JSON.stringify({ data: { items: [{ key: "A" }, { key: "B" }], secret: "hidden" } }))
    const record = await store.register("session-a", path, "compact")
    assert.ok(record)
    assert.deepEqual((await store.read("session-a", record!.id, 1024, ["data.items.key"])).data, {
      "data.items.key": ["A", "B"],
    })
    await assert.rejects(() => store.read("session-b", record!.id, 1024), /Unknown TWG artifact id/)
  } finally {
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact registration enforces quotas and isolates the copied content", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-artifact-quota-test-"))
  const path = join(root, "artifact.json")
  const store = new TwgArtifactStore(128, 64)
  try {
    await writeFile(path, JSON.stringify({ value: "original" }))
    const record = await store.register("session", path, "stdout")
    assert.ok(record)
    await writeFile(path, JSON.stringify({ value: "changed" }))
    assert.deepEqual((await store.read("session", record!.id, 128)).data, { value: "original" })
    await writeFile(join(root, "large.txt"), "x".repeat(65))
    assert.equal(await store.register("session", join(root, "large.txt"), "stdout"), null)
  } finally {
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact quota reservations are atomic and capped per session", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-artifact-concurrency-test-"))
  const store = new TwgArtifactStore(80, 64, 60)
  try {
    const first = join(root, "first.txt")
    const second = join(root, "second.txt")
    await Promise.all([writeFile(first, "a".repeat(50)), writeFile(second, "b".repeat(50))])
    const concurrent = await Promise.all([
      store.register("session-a", first, "stdout"),
      store.register("session-b", second, "stdout"),
    ])
    assert.equal(concurrent.filter(Boolean).length, 1)

    const perSessionStore = new TwgArtifactStore(128, 64, 60)
    try {
      const firstRecord = await perSessionStore.register("one-session", first, "stdout")
      const secondRecord = await perSessionStore.register("one-session", second, "stdout")
      assert.ok(firstRecord)
      assert.equal(secondRecord, null)
    } finally {
      await perSessionStore.dispose()
    }
  } finally {
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("rejected process spools are removed when registration exceeds quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "twg-artifact-spool-cleanup-test-"))
  const source = join(root, "spool.log")
  const store = new TwgArtifactStore(16, 16, 16)
  try {
    await writeFile(source, "x".repeat(17))
    assert.equal(await store.register("session", source, "process-stdout", true), null)
    await assert.rejects(access(source))
  } finally {
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
