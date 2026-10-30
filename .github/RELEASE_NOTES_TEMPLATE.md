# Release Notes Template

Copy this structure for every release. Keep section order and emoji headers consistent across releases. Omit sections that have no content — don't leave empty headers.

---

## opencode {VERSION}

{Prerelease/Stable} release from `{branch}` branch. {One-sentence summary — what's the headline change?}

---

### 🎯 Features

- **{Feature name}**: {Description. What does it do? Why does it matter? Reference PR # if applicable.}

---

### 🐛 Bug Fixes

- **{Bug}**: {Root cause in one sentence → fix in one sentence. What was broken, what changed.}

---

### 🏗️ Architecture / Refactor

- **{Change}**: {What was restructured and why. Only include if the change is user-visible or affects developers.}

---

### ⚙️ CI / Engineering

- {Change}: {What and why.}

---

### 📦 Dependencies / Tooling

- {Change}: {Version bump, revert, or tool addition/removal.}

---

### 🧪 Test Summary

```
{module}:    N pass
{module}:    N pass
total:       N tests, 0 failures
typecheck:   N/N packages green
```

---

### 🔍 Verification

{How was this release verified? Cross-review rounds, TDD coverage, live e2e status, etc. Be honest about what was and wasn't tested.}

---

**Full changelog:** [`{previous_tag}`...`{current_tag}`](https://github.com/LeXwDeX/GraphAgent/compare/{previous_tag}...{current_tag})
