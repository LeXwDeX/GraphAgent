import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { fingerprint } from "./ci-fingerprint.mjs"

// A required runner label is a non-empty string; a comma-separated list
// requires every listed label (the self-hosted platform labels are separate
// entries in the jobs API). Non-string or empty entries fail closed so a
// coerced array value can never verify as a platform string.
function requiredRunnerLabels(value) {
  if (typeof value !== "string") return []
  const labels = value.split(",").map((label) => label.trim())
  return labels.length > 0 && labels.every((label) => label.length > 0) ? labels : []
}

export function verifyEvidence(locator, expected, source) {
  if (!Number.isSafeInteger(locator.run) || locator.run <= 0) return false
  if (!Number.isSafeInteger(locator.attempt) || locator.attempt <= 0) return false
  if (!Number.isSafeInteger(locator.artifact) || locator.artifact <= 0) return false
  if (locator.job !== expected.job) return false
  const run = source.run(locator.run, locator.attempt)
  if (run.id !== locator.run || run.run_attempt !== locator.attempt || run.path !== expected.workflow) return false
  if (!/^[a-f0-9]{40}$/.test(run.head_sha)) return false
  if (!["push", "pull_request", "workflow_dispatch"].includes(run.event)) return false
  const jobs = source.jobs(locator.run, locator.attempt).filter((job) => job.name === expected.job)
  if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success") return false
  if (jobs[0].started_at?.slice(0, 10) !== expected.day) return false
  const labels = requiredRunnerLabels(expected.runner)
  if (labels.length === 0) return false
  if (!labels.every((label) => jobs[0].labels?.includes(label))) return false
  const artifact = source.artifact(locator.artifact)
  if (artifact.expired || artifact.size_in_bytes > 10000) return false
  if (artifact.name !== `${expected.artifactPrefix}-${locator.attempt}`) return false
  if (artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha) return false
  // API run.head_sha is immutable; run.pull_requests is live PR data and must
  // never stand in for the tree that an earlier run actually checked out.
  // Check the trusted workflow/source tree, then its immutable uploaded proof
  // of the tested merge tree. A forged cache can only point to these records.
  if (source.fingerprint(run.head_sha) !== expected.fingerprint) return false
  return source.proof(locator.artifact).fingerprint === expected.fingerprint
}

// Pull request caches are invisible to push runs on main. For a merge commit,
// find the merged PR head's successful run of this job so verifyEvidence can
// check it exactly as it checks a cached locator. This only proposes a
// candidate: verifyEvidence still requires the same job, runner label, day,
// immutable proof artifact, and a PR head tree identical to this checkout.
export function locateMergedPullRequest(sha, expected, source) {
  const parents = source.commit(sha).parents ?? []
  if (parents.length !== 2) return undefined
  const head = parents[1].sha
  if (typeof head !== "string" || !/^[a-f0-9]{40}$/.test(head)) return undefined
  for (const run of source.runs(head)) {
    if (run.head_sha !== head || run.event !== "pull_request" || run.path !== expected.workflow) continue
    for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
      const jobs = source.jobs(run.id, attempt).filter((job) => job.name === expected.job)
      if (jobs.length !== 1 || jobs[0].status !== "completed" || jobs[0].conclusion !== "success") continue
      const name = `${expected.artifactPrefix}-${attempt}`
      const artifacts = source.artifacts(run.id).filter((artifact) => artifact.name === name && !artifact.expired)
      if (artifacts.length !== 1) continue
      return { run: run.id, attempt, job: expected.job, artifact: artifacts[0].id }
    }
  }
  return undefined
}

function githubApi(repo) {
  return (path) =>
    JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      }),
    )
}

function expectedEvidence(repo) {
  return {
    job: process.env.CHECK_JOB,
    runner: process.env.CHECK_RUNNER,
    day: new Date().toISOString().slice(0, 10),
    workflow: process.env.GITHUB_WORKFLOW_REF.split("@")[0].slice(repo.length + 1),
    fingerprint: process.env.PRODUCT_FINGERPRINT,
    artifactPrefix: `ci-verification-${process.env.GITHUB_JOB}-${process.env.CHECK}-${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}`,
  }
}

function listJobs(api, run, attempt) {
  const jobs = []
  for (let page = 1; ; page++) {
    const result = api(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`)
    jobs.push(...result.jobs)
    if (result.jobs.length < 100) return jobs
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.env.EVIDENCE
  if (process.argv[2] === "proof") {
    mkdirSync(`${path}.artifact`, { recursive: true })
    writeFileSync(`${path}.artifact/verification.json`, JSON.stringify({ fingerprint: fingerprint() }))
  } else if (process.argv[2] === "record") {
    writeFileSync(
      path,
      JSON.stringify({
        run: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        job: process.env.CHECK_JOB,
        artifact: Number(process.env.ARTIFACT_ID),
      }),
    )
  } else if (process.argv[2] === "locate") {
    let located = false
    try {
      const repo = process.env.GITHUB_REPOSITORY
      const api = githubApi(repo)
      const expected = expectedEvidence(repo)
      const workflow = expected.workflow.split("/").pop()
      const locator = locateMergedPullRequest(process.env.GITHUB_SHA, expected, {
        commit: (sha) => api(`commits/${sha}`),
        runs: (sha) =>
          api(`actions/workflows/${workflow}/runs?event=pull_request&head_sha=${sha}&per_page=20`).workflow_runs,
        jobs: (run, attempt) => listJobs(api, run, attempt),
        artifacts: (run) => api(`actions/runs/${run}/artifacts?per_page=100`).artifacts,
      })
      if (locator) {
        writeFileSync(path, JSON.stringify(locator))
        located = true
      }
    } catch {
      console.log("Merged pull request verification could not be located; running the full suite.")
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `located=${located}\n`)
  } else {
    let reused = false
    try {
      const repo = process.env.GITHUB_REPOSITORY
      const api = githubApi(repo)
      const fetched = new Set()
      const fetch = (sha) => {
        if (fetched.has(sha)) return
        execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", sha], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30000,
        })
        fetched.add(sha)
      }
      reused = verifyEvidence(JSON.parse(readFileSync(path, "utf8")), expectedEvidence(repo), {
        run: (run, attempt) => api(`actions/runs/${run}/attempts/${attempt}`),
        jobs: (run, attempt) => listJobs(api, run, attempt),
        artifact: (id) => api(`actions/artifacts/${id}`),
        proof: (id) => {
          const zip = execFileSync("gh", ["api", `repos/${repo}/actions/artifacts/${id}/zip`], {
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 65536,
            timeout: 30000,
          })
          // Python is already part of the hosted runners used by these jobs.
          // Read one bounded JSON member in memory; never extract archive paths.
          const json = execFileSync(
            "python3",
            [
              "-c",
              "import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); i=z.getinfo('verification.json'); assert i.file_size <= 1024; sys.stdout.buffer.write(z.read(i))",
            ],
            {
              input: zip,
              encoding: "utf8",
              maxBuffer: 2048,
              timeout: 10000,
              stdio: ["pipe", "pipe", "pipe"],
            },
          )
          return JSON.parse(json)
        },
        fingerprint: (sha) => {
          fetch(sha)
          return fingerprint(sha)
        },
      })
    } catch {
      console.log("Previous verification could not be proven; running the full suite.")
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`)
    if (reused) {
      const locator = JSON.parse(readFileSync(path, "utf8"))
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Reused successful product verification\n\nGitHub confirms the source job completed successfully today on the requested runner label, and its product tree matches this checkout. Only the ordinary root SpecGit record is excluded.\n\nSource: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${locator.run}/attempts/${locator.attempt}\n`,
      )
    }
  }
}
