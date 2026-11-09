// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGlobalPathUsesConfigDirAndExistingFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GRAPHAGENT_CONFIG_DIR", dir)
	path := filepath.Join(dir, "graphagent.jsonc")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := GlobalPath(); got != path {
		t.Fatalf("GlobalPath() = %q, want %q", got, path)
	}
}

func TestDiscoverIncludesGlobalConfigCandidates(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GRAPHAGENT_CONFIG_DIR", dir)
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, source := range Discover() {
		if source.Path == path {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Discover() did not include %q", path)
	}
}

func TestDiscoverIncludesProjectDotAgentsConfig(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	agents := filepath.Join(dir, ".agents")
	if err := os.MkdirAll(agents, 0o700); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(agents, "settings.json")
	local := filepath.Join(agents, "settings.local.json")
	legacy := filepath.Join(agents, "graphagent.json")
	for _, path := range []string{settings, local, legacy} {
		if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	found := map[string]bool{}
	for _, source := range Discover() {
		found[source.Path] = true
	}
	if !found[settings] || !found[local] {
		t.Fatalf("Discover() did not include the project settings files: %v", found)
	}
	if found[legacy] {
		t.Fatalf("Discover() must not read the legacy %q", legacy)
	}
}

func TestProjectPathUsesNearestAgentsDirectory(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "project")
	nested := filepath.Join(root, "pkg", "a")
	if err := os.MkdirAll(filepath.Join(root, ".agents"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)

	want := filepath.Join(root, ".agents", "settings.json")
	if got := ProjectPath(); got != want {
		t.Fatalf("ProjectPath() = %q, want %q", got, want)
	}
}

func TestProjectPathFallsBackToGitToplevel(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(filepath.Join(repo, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("git", "-C", repo, "init").Run(); err != nil {
		t.Skip("git is unavailable")
	}
	t.Chdir(filepath.Join(repo, "sub"))

	want := filepath.Join(repo, ".agents", "settings.json")
	if got := ProjectPath(); got != want {
		t.Fatalf("ProjectPath() = %q, want %q", got, want)
	}
}

func TestProjectPathRejectsHomeAsRoot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Chdir(home)

	if got := ProjectPath(); got != "" {
		t.Fatalf("ProjectPath() = %q, want empty for $HOME", got)
	}
}
