package schema

import "testing"

func TestValidateAcceptsCurrentTopLevelKeys(t *testing.T) {
	config := map[string]any{
		"$schema":               "https://opencode.ai/config.json",
		"model":                 "openai/gpt-5.5",
		"provider":              map[string]any{},
		"reasoningDistillation": map[string]any{"enabled": false},
		"maxToolCalls":          32,
		"question_timeout":      60000,
	}
	if err := Validate(config); err != nil {
		t.Fatalf("Validate rejected a current config: %v", err)
	}
}

func TestValidateRejectsUnknownTopLevelKey(t *testing.T) {
	if err := Validate(map[string]any{"notAConfigKey": true}); err == nil {
		t.Fatal("Validate accepted an unknown top-level key")
	}
}
