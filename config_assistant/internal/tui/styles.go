// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package tui

import "github.com/charmbracelet/lipgloss"

var (
	// 配色：深色友好的青/琥珀主题
	accent = lipgloss.Color("#7DD3FC")
	warn   = lipgloss.Color("#FCD34D")
	dim    = lipgloss.Color("#64748B")
	good   = lipgloss.Color("#86EFAC")
	bad    = lipgloss.Color("#FCA5A5")
	purple = lipgloss.Color("#C4B5FD")

	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			MarginBottom(1)

	subtitleStyle = lipgloss.NewStyle().
			Foreground(dim).
			MarginBottom(1)

	selected = lipgloss.NewStyle().
			Foreground(purple).
			Bold(true)

	cursorStyle = lipgloss.NewStyle().
			Foreground(accent).
			Bold(true)

	labelStyle = lipgloss.NewStyle().
			Foreground(accent).
			Width(16)

	valueStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#E2E8F0"))

	pathStyle = lipgloss.NewStyle().
			Foreground(dim).
			Italic(true)

	existsStyle = lipgloss.NewStyle().
			Foreground(good)

	missingStyle = lipgloss.NewStyle().
			Foreground(bad)

	hintStyle = lipgloss.NewStyle().
			Foreground(dim).
			MarginTop(1)

	hdrStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(warn).
			MarginTop(1).
			MarginBottom(1)

	tagStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#1E293B")).
			Background(accent).
			Padding(0, 1)

	codeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#94A3B8"))

	dimText = lipgloss.NewStyle().
		Foreground(dim)
)
