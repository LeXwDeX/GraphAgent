// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package tui

import (
	"os"
	"strings"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func managedDisplay() string {
	return config.ManagedPath()
}

func globalDisplay() string {
	return config.GlobalPath()
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func envNonEmpty(key string) bool {
	return strings.TrimSpace(os.Getenv(key)) != ""
}

func envVal(key string) string {
	return os.Getenv(key)
}
