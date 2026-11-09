// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The project-root rules are shared with the runtime: both sides read
// packages/graphagent/test/fixtures/project-root-cases.json so a divergence in
// one implementation fails the other's test suite.
type projectRootCase struct {
	Name      string   `json:"name"`
	Directory string   `json:"directory"`
	Home      string   `json:"home"`
	Toplevel  string   `json:"toplevel"`
	Agents    []string `json:"agents"`
	Expected  string   `json:"expected"`
}

func TestResolveProjectRootSharedFixture(t *testing.T) {
	fixture := filepath.Join("..", "..", "..", "packages", "graphagent", "test", "fixtures", "project-root-cases.json")
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatalf("read shared project-root fixture: %v", err)
	}
	var cases []projectRootCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatalf("decode shared project-root fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("shared project-root fixture is empty")
	}

	// A synthetic home keeps the fixture OS-independent: nothing is created on
	// disk; the .agents/ probe answers from the fixture's `agents` list.
	home := filepath.Join(t.TempDir(), "home")
	expand := func(path string) string {
		if path == "" {
			return ""
		}
		return filepath.Clean(strings.ReplaceAll(filepath.FromSlash(path), "$HOME", home))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			agents := make([]string, 0, len(tc.Agents))
			for _, dir := range tc.Agents {
				agents = append(agents, expand(dir))
			}
			isAgentDir := func(path string) bool {
				for _, dir := range agents {
					if samePath(path, dir) {
						return true
					}
				}
				return false
			}
			got := ResolveProjectRoot(ProjectRootInput{
				Directory:   expand(tc.Directory),
				Home:        expand(tc.Home),
				Toplevel:    expand(tc.Toplevel),
				IsDirectory: isAgentDir,
			})
			if want := expand(tc.Expected); !samePath(got, want) {
				t.Fatalf("ResolveProjectRoot(%q) = %q, want %q", tc.Directory, got, want)
			}
		})
	}
}

func TestProjectRootTreatsHomeAsNoProjectLayer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Chdir(home)
	if got := projectRoot(); got != "" {
		t.Fatalf("projectRoot() = %q, want empty for $HOME", got)
	}
}
