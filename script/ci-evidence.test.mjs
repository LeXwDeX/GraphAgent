import { test } from "node:test"
import assert from "node:assert/strict"
import { locateMergedPullRequest, verifyEvidence } from "./ci-evidence.mjs"

const head = "a".repeat(40)
const base = "b".repeat(40)
function evidence() {
  const locator = { run: 12, attempt: 2, job: "Unit Tests (linux)", artifact: 34 }
  const expected = {
    job: locator.job,
    workflow: ".github/workflows/ci-test.yml",
    fingerprint: "tree-b",
    day: "2026-09-07",
    runner: "ubuntu-latest",
    artifactPrefix: "ci-verification-unit-tests-Linux-X64",
  }
  const run = { id: 12, run_attempt: 2, path: expected.workflow, head_sha: head, event: "push" }
  const jobs = [
    {
      name: locator.job,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-07T01:00:00Z",
      labels: ["ubuntu-latest"],
    },
  ]
  const artifact = {
    name: `${expected.artifactPrefix}-2`,
    size_in_bytes: 180,
    expired: false,
    workflow_run: { id: 12, head_sha: head },
  }
  const source = {
    run: () => run,
    jobs: () => jobs,
    artifact: () => artifact,
    proof: () => ({ fingerprint: "tree-b" }),
    fingerprint: (sha) => {
      assert.equal(sha, head)
      return "tree-b"
    },
  }
  return { locator, expected, run, jobs, source, artifact }
}

test("exact successful job and platform-associated source can be reused", () => {
  const e = evidence()
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
})

for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", null]) {
  test(`source conclusion ${conclusion} cannot provide success evidence`, () => {
    const e = evidence()
    e.jobs[0].conclusion = conclusion
    assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  })
}

test("a still-running job cannot lend its early saved locator", () => {
  const e = evidence()
  e.jobs[0].status = "in_progress"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("a forged cache key for B pointing to a successful A tree is rejected", () => {
  const e = evidence()
  e.source.fingerprint = () => "tree-a"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("workflow and attempt identities cannot be borrowed", () => {
  const e = evidence()
  e.run.path = ".github/workflows/other.yml"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.run.path = e.expected.workflow
  e.run.run_attempt = 1
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("missing, ambiguous, or mismatched jobs are rejected", () => {
  const e = evidence()
  e.locator.job = "Typecheck"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.locator.job = e.expected.job
  e.jobs.push({ ...e.jobs[0] })
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.jobs.length = 0
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("live PR head updates do not overwrite the source run's immutable proof", () => {
  const e = evidence()
  e.run.event = "pull_request"
  e.run.pull_requests = [{ head: { sha: base }, base: { sha: base } }]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
})

test("a formerly tested merge tree cannot lend evidence to different current content", () => {
  const e = evidence()
  e.source.proof = () => ({ fingerprint: "different-merge-tree" })
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("malformed source identities fail closed", () => {
  const e = evidence()
  e.locator.run = "12"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.locator.run = 12
  e.run.head_sha = "untrusted-revision"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("a forged current-day key cannot reuse an old source job", () => {
  const e = evidence()
  e.jobs[0].started_at = "2026-09-06T01:00:00Z"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("the source job must use the expected runner label", () => {
  const e = evidence()
  e.jobs[0].labels = ["windows-latest"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

await test("every comma-separated required runner label must appear", () => {
  const e = evidence()
  e.expected.runner = "self-hosted,Linux,X64"
  e.jobs[0].labels = ["self-hosted", "Linux", "X64"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), true)
  e.jobs[0].labels = ["self-hosted", "Linux", "ARM64"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.jobs[0].labels = ["self-hosted", "Linux"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

await test("a coerced array value never verifies as a platform label string", () => {
  const e = evidence()
  e.expected.runner = '["self-hosted","Linux","X64"]'
  e.jobs[0].labels = ["self-hosted", "Linux", "X64"]
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

await test("empty required runner labels fail closed", () => {
  const e = evidence()
  e.expected.runner = "self-hosted, ,Linux"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.expected.runner = ""
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.expected.runner = undefined
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("an artifact from another run or job cannot be borrowed", () => {
  const e = evidence()
  e.artifact.workflow_run.id = 99
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.artifact.workflow_run.id = 12
  e.artifact.name = "ci-verification-e2e-tests-Linux-X64-2"
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

test("expired or unexpectedly large artifacts fall back to full verification", () => {
  const e = evidence()
  e.artifact.expired = true
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
  e.artifact.expired = false
  e.artifact.size_in_bytes = 10001
  assert.equal(verifyEvidence(e.locator, e.expected, e.source), false)
})

const merge = "c".repeat(40)
function merged() {
  const expected = evidence().expected
  const runs = [{ id: 40, run_attempt: 1, head_sha: head, event: "pull_request", path: expected.workflow }]
  const jobs = { "40:1": [{ name: expected.job, status: "completed", conclusion: "success" }] }
  const artifacts = { 40: [{ id: 41, name: `${expected.artifactPrefix}-1`, expired: false }] }
  const source = {
    commit: (sha) => {
      assert.equal(sha, merge)
      return { parents: [{ sha: base }, { sha: head }] }
    },
    runs: (sha) => {
      assert.equal(sha, head)
      return runs
    },
    jobs: (run, attempt) => jobs[`${run}:${attempt}`] ?? [],
    artifacts: (run) => artifacts[run] ?? [],
  }
  return { expected, runs, jobs, artifacts, source }
}

void test("a merge commit locates its merged PR head's successful run", () => {
  const m = merged()
  assert.deepEqual(locateMergedPullRequest(merge, m.expected, m.source), {
    run: 40,
    attempt: 1,
    job: m.expected.job,
    artifact: 41,
  })
})

void test("a non-merge commit has no merged pull request evidence", () => {
  const m = merged()
  m.source.commit = () => ({ parents: [{ sha: base }] })
  assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined)
})

void test("runs from other events, workflows, or heads are skipped", () => {
  for (const change of [{ event: "push" }, { path: ".github/workflows/other.yml" }, { head_sha: base }]) {
    const m = merged()
    Object.assign(m.runs[0], change)
    assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined, JSON.stringify(change))
  }
})

for (const conclusion of ["failure", "cancelled", "skipped"]) {
  void test(`a ${conclusion} PR job is not proposed as evidence`, () => {
    const m = merged()
    m.jobs["40:1"][0].conclusion = conclusion
    assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined)
  })
}

void test("a missing, expired, or ambiguous proof artifact is not proposed", () => {
  const m = merged()
  m.artifacts[40] = []
  assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined)
  m.artifacts[40] = [{ id: 41, name: `${m.expected.artifactPrefix}-1`, expired: true }]
  assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined)
  m.artifacts[40] = [
    { id: 41, name: `${m.expected.artifactPrefix}-1`, expired: false },
    { id: 42, name: `${m.expected.artifactPrefix}-1`, expired: false },
  ]
  assert.equal(locateMergedPullRequest(merge, m.expected, m.source), undefined)
})

void test("an earlier successful attempt is used when a rerun attempt lacks the job", () => {
  const m = merged()
  m.runs[0].run_attempt = 2
  m.artifacts[40] = [{ id: 43, name: `${m.expected.artifactPrefix}-1`, expired: false }]
  assert.deepEqual(locateMergedPullRequest(merge, m.expected, m.source), {
    run: 40,
    attempt: 1,
    job: m.expected.job,
    artifact: 43,
  })
})
