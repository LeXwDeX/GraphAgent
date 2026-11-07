package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGlobalPathUsesConfigDirAndExistingFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GRAPHAGENT_CONFIG_DIR", dir)
	path := filepath.Join(dir, "opencode.jsonc")
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

func TestDiscoverIncludesProjectDotOpencodeConfig(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	path := filepath.Join(dir, ".opencode", "opencode.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
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
