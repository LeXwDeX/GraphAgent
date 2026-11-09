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
	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/models"
)

func (a *app) updateBrowse(msg tea.Msg) (tea.Model, tea.Cmd) {
	if a.loading {
		return a, nil
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}

	if a.filtering {
		return a.updateFilterInput(k)
	}

	switch k.String() {
	case "q", "esc":
		a.mode = modeStep2
	case "/":
		a.filtering = true
		a.filterText = ""
	case "r":
		a.reqReason = !a.reqReason
		a.applyFilter()
	case "t":
		a.reqTool = !a.reqTool
		a.applyFilter()
	case "i":
		a.reqImage = !a.reqImage
		a.applyFilter()
	case "up", "k":
		if a.cursor > 0 {
			a.cursor--
		}
	case "down", "j":
		if a.cursor < len(a.filtered)-1 {
			a.cursor++
		}
	case " ":
		a.toggleSelect()
	case "enter":
		if a.selectedCount() > 0 {
			return a.proceedFromModelSelection()
		}
	case "G":
		a.cursor = max(0, len(a.filtered)-1)
	case "g":
		a.cursor = 0
	}
	return a, nil
}

// proceedFromModelSelection 在模型选完后决定下一步：
// 若目标 provider 已有 options → 跳过 URL/KEY 直接 confirm；
// 否则进入 input 页。
func (a *app) proceedFromModelSelection() (tea.Model, tea.Cmd) {
	a.enterInputMode()
	// 如果 provider 在目标文件中已有 options，直接跳到 confirm
	target := config.TargetGlobal
	if a.step1Idx == 1 {
		target = config.TargetProject
	}
	if a.step2Idx >= 0 && config.TargetProviderHasOptions(target, a.targetProvider) {
		a.generatePreview()
		a.mode = modeConfirm
		return a, nil
	}
	a.mode = modeInput
	return a, nil
}

func (a *app) updateFilterInput(k tea.Msg) (tea.Model, tea.Cmd) {
	key, ok := k.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	switch key.String() {
	case "esc":
		a.filtering = false
		a.applyFilter()
	case "enter":
		a.filtering = false
		a.applyFilter()
	case "backspace":
		if len(a.filterText) > 0 {
			_, n := utf8.DecodeLastRuneInString(a.filterText)
			a.filterText = a.filterText[:len(a.filterText)-n]
			a.applyFilter()
		}
	case "ctrl+u":
		a.filterText = ""
		a.applyFilter()
	default:
		if key.Type == tea.KeyRunes {
			a.filterText += string(key.Runes)
			a.applyFilter()
		}
	}
	return a, nil
}

func (a *app) applyFilter() {
	a.filtered = models.Filter(a.allModels, a.filterText, a.reqReason, a.reqTool, a.reqImage)
	if a.cursor >= len(a.filtered) {
		a.cursor = max(0, len(a.filtered)-1)
	}
}

func (a *app) toggleSelect() {
	if len(a.filtered) == 0 {
		return
	}
	id := a.filtered[a.cursor].ID
	a.selected[id] = !a.selected[id]
}

func (a *app) selectedCount() int {
	count := 0
	for _, selected := range a.selected {
		if selected {
			count++
		}
	}
	return count
}

func (a *app) viewBrowse() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("第 3 步：选择要添加的模型") + "\n")
	b.WriteString(subtitleStyle.Render(fmt.Sprintf("目标 Provider: %s", cursorStyle.Render(a.targetProvider))) + "\n")

	// 能力开关
	b.WriteString("能力: " + toggle("r 推理", a.reqReason) + " " +
		toggle("t 工具", a.reqTool) + " " +
		toggle("i 图像", a.reqImage) + "\n")

	b.WriteString(fmt.Sprintf("%s %d 个模型，已选 %d 个",
		dimText.Render("●"), len(a.filtered), a.selectedCount()))

	if a.loadErr != "" {
		b.WriteString("\n" + missingStyle.Render("模型加载失败: "+a.loadErr+"（可继续浏览已缓存数据）"))
	}

	// 过滤输入行
	if a.filtering {
		inputBox := lipgloss.NewStyle().
			Foreground(accent).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(accent).
			Padding(0, 1)
		disp := a.filterText
		if disp == "" {
			disp = dimText.Render("输入关键词过滤...")
		}
		b.WriteString("\n" + inputBox.Render("过滤 › "+disp+accentCursor()))
	} else if a.filterText != "" {
		b.WriteString(fmt.Sprintf("  过滤: %s", cursorStyle.Render(a.filterText)))
	}
	b.WriteString("\n\n")

	// 列表渲染（带滚动窗口）
	reserved := 12
	if a.filtering {
		reserved = 14
	}
	listHeight := a.height - reserved
	if listHeight < 5 {
		listHeight = 5
	}
	start := a.cursor - listHeight/2
	if start < 0 {
		start = 0
	}
	end := start + listHeight
	if end > len(a.filtered) {
		end = len(a.filtered)
	}
	if end-start < listHeight && start > 0 {
		start = max(0, end-listHeight)
	}

	for i := start; i < end; i++ {
		m := a.filtered[i]
		b.WriteString(a.renderModelLine(i, m))
	}

	// 详情预览
	if len(a.filtered) > 0 {
		cur := a.filtered[a.cursor]
		b.WriteString("\n" + hdrStyle.Render("详情"))
		b.WriteString(fmt.Sprintf("  %s\n", valueStyle.Render(cur.Description)))
		b.WriteString(fmt.Sprintf("  上下文 %s · 输出 %s · %s · %s · %s\n",
			cur.ContextK(), cur.OutputK(),
			boolTag("推理", cur.Reasoning), boolTag("工具", cur.ToolCall), boolTag("图像", cur.Attachment)))
		if cur.HasCost() {
			b.WriteString(fmt.Sprintf("  价格 输入 %s · 输出 %s\n", cur.CostInputStr(), cur.CostOutputStr()))
		}
	}

	hint := "\n/ 过滤 · r/t/i 能力 · j/k 移动 · space 选择 · enter 下一步 · q 返回"
	if a.filtering {
		hint = "\n输入过滤词 · enter/esc 完成"
	}
	b.WriteString(hintStyle.Render(hint))
	return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
}

func (a *app) renderModelLine(idx int, m models.Model) string {
	cursor := "  "
	style := valueStyle
	if idx == a.cursor {
		cursor = "▶ "
		style = cursorStyle
	}
	mark := "○"
	if a.selected[m.ID] {
		mark = "●"
		markStr := selected.Render(mark)
		return fmt.Sprintf("%s%s %s  %s  %sK  %s\n",
			cursor, markStr, style.Render(m.ID),
			caps(m), m.ContextK(), dimText.Render(m.Name))
	}
	return fmt.Sprintf("%s%s %s  %s  %sK  %s\n",
		cursor, mark, style.Render(m.ID),
		caps(m), m.ContextK(), dimText.Render(m.Name))
}

func caps(m models.Model) string {
	var tags []string
	if m.Reasoning {
		tags = append(tags, tagStyle.Render("R"))
	}
	if m.ToolCall {
		tags = append(tags, tagStyle.Render("T"))
	}
	if m.Attachment {
		tags = append(tags, tagStyle.Render("I"))
	}
	return strings.Join(tags, " ")
}

func toggle(label string, on bool) string {
	if on {
		return lipgloss.NewStyle().Foreground(good).Render("[x] " + label)
	}
	return dimText.Render("[ ] " + label)
}

func boolTag(label string, on bool) string {
	if on {
		return lipgloss.NewStyle().Foreground(good).Render(label + ":✓")
	}
	return dimText.Render(label + ":✗")
}

func accentCursor() string {
	return lipgloss.NewStyle().Foreground(accent).Render("▏")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// enterInputMode 准备 provider 选项输入：用 step2 选定的单一 targetProvider。
func (a *app) enterInputMode() {
	a.provOrder = []string{a.targetProvider}
	a.provIdx = 0
	a.fieldIdx = 0
}
