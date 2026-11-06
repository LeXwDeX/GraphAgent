package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/models"
)

func TestGenerateFromModelsSetsMainModel(t *testing.T) {
	model := models.Model{
		ID:        "openai/gpt-4.1",
		Name:      "GPT-4.1",
		Reasoning: true,
	}

	got := GenerateFromModels(GenRequest{
		Selected:    []models.Model{model},
		MainModelID: model.ID,
	})

	if got["model"] != model.ID {
		t.Fatalf("model = %v, want %q", got["model"], model.ID)
	}
}

func TestGenerateFromModelsSkipsMainModelWhenSkipped(t *testing.T) {
	model := models.Model{ID: "openai/gpt-4.1"}

	got := GenerateFromModels(GenRequest{
		Selected:    []models.Model{model},
		MainModelID: model.ID,
		SkipModels:  map[string]bool{model.ID: true},
	})

	if _, ok := got["model"]; ok {
		t.Fatalf("model = %v, want no top-level model", got["model"])
	}
}

func TestGenerateFromModelsMapsMainModelToTargetProvider(t *testing.T) {
	model := models.Model{
		ID:   "openai/gpt-4.1",
		Name: "GPT-4.1",
		Limit: models.Limit{
			Context: 128000,
		},
		Cost: models.Cost{Output: 2},
	}

	got := GenerateFromModels(GenRequest{
		Selected:       []models.Model{model},
		MainModelID:    model.ID,
		TargetProvider: map[string]string{model.ID: "openrouter"},
	})

	if got["model"] != "openrouter/gpt-4.1" {
		t.Fatalf("model = %v, want %q", got["model"], "openrouter/gpt-4.1")
	}
	provider := got["provider"].(map[string]any)
	modelBlock := provider["openrouter"].(map[string]any)["models"].(map[string]any)["gpt-4.1"].(map[string]any)
	limit := modelBlock["limit"].(map[string]any)
	if limit["context"] != 128000 || limit["output"] != 0 {
		t.Fatalf("limit = %v, want required context/output fields", limit)
	}
	cost := modelBlock["cost"].(map[string]any)
	if cost["input"] != float64(0) || cost["output"] != float64(2) {
		t.Fatalf("cost = %v, want required input/output fields", cost)
	}
}

func TestParseJSONCAndDeepMerge(t *testing.T) {
	base, err := parseJSONC([]byte(`{
		"provider": {"openai": {"options": {"apiKey": "key"}}},
		// keep comments and trailing commas valid
		"model": "openai/gpt-4o",
		"tags": ["a",],
	}`))
	if err != nil {
		t.Fatal(err)
	}
	override, err := parseJSONC([]byte(`{"provider":{"openai":{"models":{"gpt-4.1":{}}}}}`))
	if err != nil {
		t.Fatal(err)
	}

	got := deepMerge(base, override)
	provider := got["provider"].(map[string]any)
	openai := provider["openai"].(map[string]any)
	if _, ok := openai["options"]; !ok {
		t.Fatal("deepMerge dropped existing provider options")
	}
	if _, ok := openai["models"]; !ok {
		t.Fatal("deepMerge dropped generated provider models")
	}
}

func TestRedactSensitive(t *testing.T) {
	got := RedactSensitive(map[string]any{
		"provider": map[string]any{
			"openai": map[string]any{
				"options": map[string]any{
					"apiKey": "secret",
					"token":  "{env:OPENAI_TOKEN}",
				},
			},
		},
	})
	options := got["provider"].(map[string]any)["openai"].(map[string]any)["options"].(map[string]any)
	if options["apiKey"] != "***" {
		t.Fatalf("apiKey = %v, want redacted", options["apiKey"])
	}
	if options["token"] != "{env:OPENAI_TOKEN}" {
		t.Fatalf("token = %v, want reference preserved", options["token"])
	}
}

func TestWriteFileUsesPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.json")
	if _, err := WriteFile(path, []byte(`{"provider":{}}`)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
}

func TestWriteFileIfUnchangedRejectsStaleSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "opencode.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteFileIfUnchanged(path, []byte("new"), []byte("stale"), true); err == nil {
		t.Fatal("WriteFileIfUnchanged() error = nil, want stale snapshot error")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "old" {
		t.Fatalf("file = %q, want unchanged content", data)
	}
}

func TestSubstituteVarsReportsMissingFile(t *testing.T) {
	_, err := substituteVars(map[string]any{
		"provider": map[string]any{"options": map[string]any{"apiKey": "{file:missing-key}"}},
	}, t.TempDir()+"/opencode.json")
	if err == nil {
		t.Fatal("substituteVars() error = nil, want missing file error")
	}
}

func TestTargetGlobalRejectsEmptyHome(t *testing.T) {
	t.Setenv("OPENCODE_CONFIG_DIR", "")
	home, hadHome := os.LookupEnv("HOME")
	t.Setenv("HOME", "")
	defer func() {
		if hadHome {
			os.Setenv("HOME", home)
		}
	}()

	if _, err := targetPath(TargetGlobal); err == nil {
		t.Fatal("targetPath(TargetGlobal) error = nil, want rejection when HOME is unset")
	}
}
