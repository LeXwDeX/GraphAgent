// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package tui

import (
	"fmt"
	"strings"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func (a *app) updateInput(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	cur := a.provOrder[a.provIdx]
	switch k.String() {
	case "esc":
		a.mode = modeBrowse
	case "tab":
		a.fieldIdx = 1 - a.fieldIdx
	case "enter":
		// 保存并前进到下一个 provider，或进入确认
		a.provIdx++
		a.fieldIdx = 0
		if a.provIdx >= len(a.provOrder) {
			a.generatePreview()
			a.mode = modeConfirm
		}
	case "backspace":
		a.backspaceField(cur)
	case "ctrl+u":
		a.clearField(cur)
	default:
		if k.Type == tea.KeyRunes {
			a.typeField(cur, string(k.Runes))
		}
	}
	return a, nil
}

func (a *app) typeField(prov, runes string) {
	switch a.fieldIdx {
	case 0:
		a.baseURLs[prov] += runes
	case 1:
		a.apiKeys[prov] += runes
	}
}

func (a *app) backspaceField(prov string) {
	switch a.fieldIdx {
	case 0:
		if s := a.baseURLs[prov]; len(s) > 0 {
			_, n := utf8.DecodeLastRuneInString(s)
			a.baseURLs[prov] = s[:len(s)-n]
		}
	case 1:
		if s := a.apiKeys[prov]; len(s) > 0 {
			_, n := utf8.DecodeLastRuneInString(s)
			a.apiKeys[prov] = s[:len(s)-n]
		}
	}
}

func (a *app) clearField(prov string) {
	switch a.fieldIdx {
	case 0:
		a.baseURLs[prov] = ""
	case 1:
		a.apiKeys[prov] = ""
	}
}

func (a *app) viewInput() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Provider 连接配置") + "\n")
	b.WriteString(subtitleStyle.Render(
		fmt.Sprintf("为选中的模型所属 provider 设置自定义端点和密钥（均可留空）  %d/%d",
			a.provIdx+1, len(a.provOrder))) + "\n\n")

	// 进度条
	for i, p := range a.provOrder {
		marker := "  "
		style := valueStyle
		if i == a.provIdx {
			marker = "▶ "
			style = cursorStyle
		} else if i < a.provIdx {
			marker = "✓ "
			style = lipgloss.NewStyle().Foreground(good)
		}
		b.WriteString(fmt.Sprintf("%s%s\n", marker, style.Render(p)))
	}

	if len(a.provOrder) > 0 {
		cur := a.provOrder[a.provIdx]
		b.WriteString("\n" + hdrStyle.Render(fmt.Sprintf("配置 %s", cur)) + "\n")

		baseURLVal := a.baseURLs[cur]
		apiKeyVal := maskKey(a.apiKeys[cur])

		baseURLLine := a.inputLine("Base URL", baseURLVal, a.fieldIdx == 0)
		apiKeyLine := a.inputLine("API Key", apiKeyVal, a.fieldIdx == 1)

		b.WriteString(baseURLLine)
		b.WriteString(apiKeyLine)

		b.WriteString(dimText.Render(
			"  提示：API Key 建议用 {env:VAR_NAME} 或 {file:path} 引用，避免明文写入配置") + "\n")
	}

	b.WriteString(hintStyle.Render(
		"\ntab 切换字段 · enter 下一个 provider · esc 返回浏览器"))
	return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
}

func (a *app) inputLine(label, value string, active bool) string {
	cursor := accentCursor()
	disp := value
	if active {
		disp = value + cursor
	}
	if value == "" && active {
		disp = dimText.Render("(空)") + cursor
	} else if value == "" {
		disp = dimText.Render("(空)")
	}
	style := labelStyle
	if active {
		style = lipgloss.NewStyle().Foreground(accent).Bold(true).Width(16)
	}
	return fmt.Sprintf("  %s %s\n", style.Render(label), disp)
}

// maskKey 对已输入的密钥做部分遮罩，只显示末尾 4 位，避免在屏幕上完整暴露。
func maskKey(s string) string {
	if s == "" {
		return ""
	}
	// 不遮罩变量引用格式 {env:...}/{file:...}
	if strings.HasPrefix(s, "{") {
		return s
	}
	r := []rune(s)
	if len(r) <= 4 {
		return strings.Repeat("•", len(r))
	}
	return strings.Repeat("•", len(r)-4) + string(r[len(r)-4:])
}

// _ 保留 config 引用以备未来扩展（如校验 baseURL 格式）
var _ = config.TargetGlobal
