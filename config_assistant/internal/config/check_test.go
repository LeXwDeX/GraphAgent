// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package config

import "testing"

func TestCheckProvidersBlocksDisabledModelWithWhitelist(t *testing.T) {
	result := CheckProviders(map[string]any{
		"model":              "openai/gpt-4.1",
		"enabled_providers":  []any{"openai"},
		"disabled_providers": []any{"openai"},
	})

	if !result.HasProblems() {
		t.Fatal("CheckProviders() reports no blocking issue for a disabled model")
	}
}

func TestCheckProvidersTreatsEmptyWhitelistAsConfigured(t *testing.T) {
	result := CheckProviders(map[string]any{
		"model":             "openai/gpt-4.1",
		"enabled_providers": []any{},
	})

	if !result.HasProblems() {
		t.Fatal("CheckProviders() reports no blocking issue for an empty whitelist")
	}
}
