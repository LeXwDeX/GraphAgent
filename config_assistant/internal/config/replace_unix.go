// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package config

import "os"

func replaceFile(source, target string) error {
	return os.Rename(source, target)
}
