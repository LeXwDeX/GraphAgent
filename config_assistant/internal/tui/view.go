package tui

import (
	"encoding/json"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func (a *app) updateView(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	switch k.String() {
	case "q", "esc":
		a.mode = modeMenu
	case "r":
		return a, loadConfig
	}
	return a, nil
}

func (a *app) viewView() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("当前环境配置") + "\n")

	if a.viewErr != "" {
		// JSON 解析错误：醒目警告 + 原始错误 + 阻止继续
		box := lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(bad).
			Padding(1, 2).
			MarginBottom(1).
			Render(
				missingStyle.Render("✗ 配置文件解析失败") + "\n\n" +
					valueStyle.Render(a.viewErr) + "\n\n" +
					dimText.Render("请先修复该文件的 JSON 语法错误后再操作。") + "\n" +
					dimText.Render("可用 `graphagent debug config` 或 JSON 校验工具检查。"))
		b.WriteString(box + "\n")
		b.WriteString(hintStyle.Render("q 返回主菜单 · r 重新加载"))
		return lipgloss.NewStyle().Padding(1, 2).MaxHeight(a.height).Render(b.String())
	}

	b.WriteString(hdrStyle.Render("配置来源（按优先级高→低）") + "\n")
	if len(a.loaded) == 0 {
		b.WriteString(dimText.Render("  （无已存在的配置文件）") + "\n")
	} else {
		for _, l := range a.loaded {
			status := existsStyle.Render("● 存在")
			path := ""
			if l.Source.Path != "" {
				path = pathStyle.Render(l.Source.Path)
			}
			b.WriteString(fmt.Sprintf("  %s %s  %s\n",
				labelStyle.Render(l.Source.Label), status, path))
		}
	}

	// 同时展示未找到的来源
	b.WriteString(hdrStyle.Render("已扫描位置") + "\n")
	for _, src := range discoverAll() {
		mark := missingStyle.Render("○ 缺失")
		if src.Exists {
			mark = existsStyle.Render("● 存在")
		}
		path := pathStyle.Render(src.Path)
		if src.Path == "" {
			path = dimText.Render("(环境变量)")
		}
		b.WriteString(fmt.Sprintf("  %s %s  %s\n", labelStyle.Render(src.Label), mark, path))
	}

	b.WriteString(hdrStyle.Render("合并后的最终配置"))
	if len(a.merged) == 0 {
		b.WriteString("\n" + dimText.Render("  （空 — 未发现任何配置）") + "\n")
	} else {
		// provider 一致性检测
		check := config.CheckProviders(a.merged)
		b.WriteString(renderCheckResult(check))

		preview, _ := json.MarshalIndent(config.RedactSensitive(a.merged), "  ", "  ")
		lines := strings.Split(string(preview), "\n")
		for _, ln := range lines {
			b.WriteString("  " + codeStyle.Render(ln) + "\n")
		}
	}

	b.WriteString(hintStyle.Render("\nq 返回 · r 重新加载"))
	content := b.String()
	return lipgloss.NewStyle().Padding(1, 2).MaxHeight(a.height).Render(content)
}

// renderCheckResult 把检测结果格式化为可展示的文本块。
func renderCheckResult(check config.CheckResult) string {
	if len(check.Issues) == 0 && len(check.Warnings) == 0 && len(check.Infos) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n")
	for _, iss := range check.Issues {
		b.WriteString(missingStyle.Render("✗ "+iss.Message) + "\n")
		if iss.Detail != "" {
			b.WriteString("  " + dimText.Render("→ "+iss.Detail) + "\n")
		}
	}
	for _, iss := range check.Warnings {
		b.WriteString(lipgloss.NewStyle().Foreground(warn).Render("⚠ "+iss.Message) + "\n")
		if iss.Detail != "" {
			b.WriteString("  " + dimText.Render("→ "+iss.Detail) + "\n")
		}
	}
	for _, iss := range check.Infos {
		b.WriteString(lipgloss.NewStyle().Foreground(accent).Render("ℹ "+iss.Message) + "\n")
	}
	b.WriteString("\n")
	return b.String()
}

// discoverAll 返回所有可能的来源（含缺失的），用于查看模式的完整扫描展示。
func discoverAll() []sourceDisplay {
	return []sourceDisplay{
		{Label: "Managed", Path: managedDisplay(), Exists: fileExists(managedDisplay())},
		{Label: "Inline", Path: "", Exists: envNonEmpty("GRAPHAGENT_CONFIG_CONTENT")},
		{Label: "Project", Path: "(当前目录向上查找)", Exists: false},
		{Label: "Custom", Path: envVal("GRAPHAGENT_CONFIG"), Exists: fileExists(envVal("GRAPHAGENT_CONFIG"))},
		{Label: "Global", Path: globalDisplay(), Exists: fileExists(globalDisplay())},
	}
}

type sourceDisplay struct {
	Label  string
	Path   string
	Exists bool
}
