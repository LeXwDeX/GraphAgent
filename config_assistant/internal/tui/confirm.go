// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package tui

import (
	"encoding/json"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func (a *app) updateConfirm(msg tea.Msg) (tea.Model, tea.Cmd) {
	if a.confirmDone {
		if _, ok := msg.(tea.KeyMsg); ok {
			a.confirmDone = false
			a.mode = modeMenu
			a.selected = map[string]bool{}
		}
		return a, nil
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	switch k.String() {
	case "q", "esc":
		a.mode = modeBrowse
	case "enter", "w":
		if a.genErr != "" || a.genPath == "" || len(a.genBytes) == 0 {
			return a, nil
		}
		backup, err := config.WriteFileIfUnchanged(a.genPath, a.genBytes, a.genSource, a.genSourceOK)
		if err != nil {
			a.genErr = err.Error()
		} else {
			a.confirmDone = true
			if backup != "" {
				a.confirmMsg = fmt.Sprintf("配置已写入 %s\n备份已保存: %s", a.genPath, backup)
			} else {
				a.confirmMsg = fmt.Sprintf("配置已写入 %s（新建文件，无备份）", a.genPath)
			}
			a.genErr = ""
		}
	}
	return a, nil
}

func (a *app) viewConfirm() string {
	if a.confirmDone {
		var b strings.Builder
		b.WriteString("\n\n")
		box := lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(good).
			Padding(1, 3).
			Render(
				existsStyle.Render("✓ 写入成功") + "\n\n" +
					valueStyle.Render(a.confirmMsg) + "\n\n" +
					dimText.Render("选中的模型已自动填充 provider 配置块。") + "\n" +
					dimText.Render("建议在 provider.options.apiKey 中使用 {env:API_KEY} 引用密钥。"))
		b.WriteString(box)
		b.WriteString(hintStyle.Render("\n\n按任意键返回主菜单"))
		return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
	}

	var b strings.Builder
	b.WriteString(titleStyle.Render("确认写入配置") + "\n")
	b.WriteString(subtitleStyle.Render(fmt.Sprintf("已选 %d 个模型 → Provider: %s", len(a.selected), cursorStyle.Render(a.targetProvider))) + "\n")

	// 路径
	b.WriteString(hdrStyle.Render("输出路径"))
	b.WriteString(fmt.Sprintf("  %s\n", pathStyle.Render(a.genPath)))

	// 冲突警告（目标文件中已存在的同名模型，将被覆盖）
	if len(a.conflicts) > 0 {
		b.WriteString(hdrStyle.Render(fmt.Sprintf("⚠ %d 个模型已存在，将被覆盖", len(a.conflicts))))
		for _, c := range a.conflicts {
			b.WriteString(fmt.Sprintf("  %s  %s/%s  %s\n",
				lipgloss.NewStyle().Foreground(warn).Render("＊"),
				c.Provider, c.Model,
				dimText.Render("(原文件已存在)")))
		}
	}

	// 变更清单
	if len(a.changes) > 0 {
		b.WriteString(hdrStyle.Render("将写入的变更"))
		for _, ch := range a.changes {
			icon := lipgloss.NewStyle().Foreground(good).Render("＋ 新增")
			if ch.Kind == config.ChangeModify {
				icon = lipgloss.NewStyle().Foreground(warn).Render("＊ 修改")
			}
			b.WriteString(fmt.Sprintf("  %s %-16s %s\n", icon,
				cursorStyle.Render(ch.Key), dimText.Render(ch.Summary)))
		}
		b.WriteString(dimText.Render("   写入前会自动备份原文件") + "\n")
	}

	// provider 一致性检测
	if a.genMerged != nil {
		check := config.CheckProviders(a.genMerged)
		b.WriteString(renderCheckResult(check))
	}

	// 预览
	if a.genBytes != nil {
		b.WriteString(hdrStyle.Render("预览"))
		previewBytes, _ := json.MarshalIndent(config.RedactSensitive(a.genMerged), "  ", "  ")
		preview := strings.TrimSpace(string(previewBytes))
		lines := strings.Split(preview, "\n")
		maxLines := a.height - 16
		if maxLines < 8 {
			maxLines = 8
		}
		if len(lines) > maxLines {
			lines = append(lines[:maxLines], dimText.Render(fmt.Sprintf("  ... (%d 行已省略)", len(lines)-maxLines)))
		}
		for _, ln := range lines {
			b.WriteString("  " + codeStyle.Render(ln) + "\n")
		}
	}

	if a.genErr != "" {
		b.WriteString(missingStyle.Render("错误: "+a.genErr) + "\n")
	}

	// 同后缀冲突警告
	if len(a.dupes) > 0 {
		b.WriteString(hdrStyle.Render("⚠ 同名模型冲突"))
		for _, d := range a.dupes {
			b.WriteString(fmt.Sprintf("  %s %s  %s\n",
				lipgloss.NewStyle().Foreground(warn).Render("＊"), d,
				dimText.Render("(后者将覆盖前者)")))
		}
	}

	b.WriteString(hintStyle.Render("\nenter 写入 · q 返回模型选择"))
	return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
}
