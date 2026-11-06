package tui

import (
	"fmt"
	"strings"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
)

func (a *app) updateStep2(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}

	// 新建 provider 名输入模式
	if a.step2Naming {
		return a.updateStep2Naming(k)
	}

	switch k.String() {
	case "q", "esc":
		a.mode = modeStep1
	case "up", "k":
		if a.step2Idx > -1 {
			a.step2Idx--
		}
	case "down", "j":
		// 最大序号 = len(choices)-1，-1 是"新建"项
		if a.step2Idx < len(a.step2Choices)-1 {
			a.step2Idx++
		}
	case "n":
		// 进入新建命名
		a.step2Naming = true
		a.step2NewName = ""
	case "enter":
		return a.confirmStep2()
	}
	return a, nil
}

func (a *app) updateStep2Naming(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "esc":
		a.step2Naming = false
		a.step2NewName = ""
	case "enter":
		name := strings.TrimSpace(a.step2NewName)
		if name == "" {
			return a, nil
		}
		a.targetProvider = name
		a.step2Naming = false
		return a.enterBrowseFromStep2()
	case "backspace":
		if len(a.step2NewName) > 0 {
			_, n := utf8.DecodeLastRuneInString(a.step2NewName)
			a.step2NewName = a.step2NewName[:len(a.step2NewName)-n]
		}
	case "ctrl+u":
		a.step2NewName = ""
	default:
		if k.Type == tea.KeyRunes {
			a.step2NewName += string(k.Runes)
		}
	}
	return a, nil
}

func (a *app) confirmStep2() (tea.Model, tea.Cmd) {
	if a.step2Idx == -1 {
		// 选中"新建"，进入命名
		a.step2Naming = true
		a.step2NewName = ""
		return a, nil
	}
	// 选了已有 provider
	if a.step2Idx >= 0 && a.step2Idx < len(a.step2Choices) {
		a.targetProvider = a.step2Choices[a.step2Idx]
		return a.enterBrowseFromStep2()
	}
	return a, nil
}

// enterBrowseFromStep2 进入模型浏览（第三步），按需加载模型数据。
func (a *app) enterBrowseFromStep2() (tea.Model, tea.Cmd) {
	a.mode = modeBrowse
	a.selected = map[string]bool{}
	a.filterText = ""
	a.filtering = false
	a.cursor = 0
	a.reqReason = false
	a.reqTool = false
	a.reqImage = false
	if len(a.allModels) == 0 {
		a.loading = true
		return a, loadModels
	}
	a.filtered = a.allModels
	return a, nil
}

func (a *app) viewStep2() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("第 2 步：选择目标 Provider") + "\n")
	b.WriteString(subtitleStyle.Render("模型将添加到此 provider 下（之后可改）") + "\n\n")

	// "新建" 选项（序号 -1）
	newMarker := "  "
	newStyle := valueStyle
	if a.step2Idx == -1 {
		newMarker = "▶ "
		newStyle = cursorStyle
	}
	b.WriteString(fmt.Sprintf("%s%s %s\n", newMarker,
		newStyle.Render("＋ 新建 Provider"),
		dimText.Render("(手动输入名字)")))

	// 已有 provider 列表
	for i, p := range a.step2Choices {
		marker := "  "
		style := valueStyle
		if i == a.step2Idx {
			marker = "▶ "
			style = cursorStyle
		}
		// 标记是否已有 options（读目标文件，非 merged）
		target := config.TargetGlobal
		if a.step1Idx == 1 {
			target = config.TargetProject
		}
		optsTag := ""
		if config.TargetProviderHasOptions(target, p) {
			optsTag = " " + lipgloss.NewStyle().Foreground(good).Render("(已有 URL/KEY)")
		}
		b.WriteString(fmt.Sprintf("%s%s%s\n", marker, style.Render(p), optsTag))
	}

	// 命名输入框
	if a.step2Naming {
		b.WriteString("\n" + hdrStyle.Render("输入新 Provider 名"))
		disp := a.step2NewName
		if disp == "" {
			disp = dimText.Render("例如: local-proxy-openai")
		}
		b.WriteString(fmt.Sprintf("  %s%s\n", cursorStyle.Render(disp), accentCursor()))
		b.WriteString(dimText.Render("  enter 确认 · esc 取消") + "\n")
	}

	hint := "\nenter 确认/新建 · n 新建 · j/k 移动 · q 返回"
	if a.step2Naming {
		hint = "\nenter 确认名字 · esc 取消"
	}
	b.WriteString(hintStyle.Render(hint))
	return lipgloss.NewStyle().Padding(1, 2).Render(b.String())
}
