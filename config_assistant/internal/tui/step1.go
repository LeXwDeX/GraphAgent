package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func (a *app) updateStep1(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	switch k.String() {
	case "q", "esc":
		a.mode = modeMenu
	case "up", "k":
		if a.step1Idx > 0 {
			a.step1Idx--
		}
	case "down", "j":
		if a.step1Idx < 1 {
			a.step1Idx++
		}
	case "g":
		a.step1Idx = 0
	case "p":
		a.step1Idx = 1
	case "enter":
		// step2Idx=-1 表示"新建"，否则是已有序号
		a.step2Idx = -1
		a.step2Naming = false
		a.step2NewName = ""
		a.mode = modeStep2
	}
	return a, nil
}

func (a *app) viewStep1() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("第 1 步：选择目标配置文件") + "\n")
	b.WriteString(subtitleStyle.Render("模型将添加到以下文件（可后续切换）") + "\n\n")

	targets := []struct {
		label string
		path  string
	}{
		{"Global（全局）", config.GlobalPath()},
		{"Project（项目）", config.ProjectPath()},
	}
	for i, t := range targets {
		marker := "  "
		style := valueStyle
		if i == a.step1Idx {
			marker = "▶ "
			style = cursorStyle
		}
		b.WriteString(fmt.Sprintf("%s%s\n", marker, style.Render(t.label)))
		path := t.path
		if path == "" {
			path = "（不可用：项目根为 $HOME 或无可用目录）"
		}
		b.WriteString(fmt.Sprintf("   %s\n", pathStyle.Render(path)))
		if i == 0 && len(a.step2Choices) > 0 {
			b.WriteString("   " + dimText.Render(fmt.Sprintf("已有 %d 个 provider 可选", len(a.step2Choices))) + "\n")
		}
	}

	b.WriteString("\n" + hintStyle.Render("g/p 切换 · enter 下一步 · q 返回"))
	return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
}
