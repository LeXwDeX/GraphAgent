package tui

import (
	"fmt"
	"sort"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/models"
)

type mode int

const (
	modeMenu mode = iota
	modeView
	modeStep1  // 确认操作 + 配置文件路径
	modeStep2  // 选择/新建 provider
	modeBrowse // 第三步：选择模型
	modeInput
	modeConfirm
)

type app struct {
	mode     mode
	width    int
	height   int
	menuIdx  int
	menuItem []string

	// view
	loaded  []config.Loaded
	merged  map[string]any
	viewErr string

	// step1 (确认操作 + 目标文件)
	step1Idx  int // 0=Global, 1=Project
	step1Done bool

	// step2 (选择/新建 provider)
	step2Idx     int // -1=新建, >=0=已有序号
	step2NewName string
	step2Naming  bool     // 是否正在输入新 provider 名
	step2Choices []string // 已有 provider 列表
	step2Done    bool

	// browse
	allModels  []models.Model
	filtered   []models.Model
	cursor     int
	selected   map[string]bool
	filterText string
	filtering  bool
	reqReason  bool
	reqTool    bool
	reqImage   bool
	loadErr    string
	loading    bool

	// confirm
	genPath     string
	genBytes    []byte
	genMerged   map[string]any
	genSource   []byte
	genSourceOK bool
	genErr      string
	changes     []config.Change
	conflicts   []config.ModelConflict
	dupes       []string // 同后缀冲突警告
	confirmDone bool
	confirmMsg  string

	// input (provider opts) — 仅当 provider 无现有 options 时进入
	provOrder []string // 涉及的 provider 名，按出现顺序
	provIdx   int      // 当前编辑哪个 provider
	fieldIdx  int      // 0=baseURL, 1=apiKey
	baseURLs  map[string]string
	apiKeys   map[string]string

	// 目标 provider（step2 的结果，所有选中模型统一用这一个）
	targetProvider   string
	enabledProviders []string
}

func New() *app {
	return &app{
		mode:     modeMenu,
		menuItem: []string{"查看当前环境配置", "向配置添加模型", "退出"},
		selected: map[string]bool{},
		merged:   map[string]any{},
		step2Idx: -1,
		baseURLs: map[string]string{},
		apiKeys:  map[string]string{},
	}
}

func (a *app) Init() tea.Cmd {
	return tea.SetWindowTitle("配置助手 · opencode config")
}

func (a *app) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		a.width, a.height = m.Width, m.Height
		return a, nil

	case tea.KeyMsg:
		switch m.String() {
		case "ctrl+c":
			return a, tea.Quit
		}

	case modelsLoadedMsg:
		a.loading = false
		a.allModels = models.Sorted(m.models)
		a.filtered = a.allModels
		if m.err != nil {
			a.loadErr = m.err.Error()
		}
		return a, nil

	case configLoadedMsg:
		a.loaded = m.loaded
		a.merged = m.merged
		a.enabledProviders = extractEnabledProviders(m.merged)
		a.step2Choices = extractExistingProviders(m.merged)
		if m.err != nil {
			a.viewErr = m.err.Error()
		}
		return a, nil
	}

	switch a.mode {
	case modeMenu:
		return a.updateMenu(msg)
	case modeView:
		return a.updateView(msg)
	case modeStep1:
		return a.updateStep1(msg)
	case modeStep2:
		return a.updateStep2(msg)
	case modeBrowse:
		return a.updateBrowse(msg)
	case modeInput:
		return a.updateInput(msg)
	case modeConfirm:
		return a.updateConfirm(msg)
	}
	return a, nil
}

func (a *app) updateMenu(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return a, nil
	}
	switch k.String() {
	case "q", "esc":
		return a, tea.Quit
	case "up", "k":
		if a.menuIdx > 0 {
			a.menuIdx--
		}
	case "down", "j":
		if a.menuIdx < len(a.menuItem)-1 {
			a.menuIdx++
		}
	case "enter":
		switch a.menuIdx {
		case 0:
			a.mode = modeView
			return a, loadConfig
		case 1:
			a.mode = modeStep1
			a.step1Done = false
			a.step1Idx = 0
			a.step2Done = false
			a.step2Idx = -1
			a.step2NewName = ""
			a.step2Naming = false
			a.selected = map[string]bool{}
			a.targetProvider = ""
			a.baseURLs = map[string]string{}
			a.apiKeys = map[string]string{}
			a.reqReason = false
			a.reqTool = false
			a.reqImage = false
			a.conflicts = nil
			return a, loadConfig
		case 2:
			return a, tea.Quit
		}
	}
	return a, nil
}

func (a *app) View() string {
	if a.width == 0 {
		return "正在启动..."
	}
	switch a.mode {
	case modeMenu:
		return a.viewMenu()
	case modeView:
		return a.viewView()
	case modeStep1:
		return a.viewStep1()
	case modeStep2:
		return a.viewStep2()
	case modeBrowse:
		return a.viewBrowse()
	case modeInput:
		return a.viewInput()
	case modeConfirm:
		return a.viewConfirm()
	}
	return ""
}

func (a *app) viewMenu() string {
	var b string
	b += titleStyle.Render("配置助手") + "\n"
	b += subtitleStyle.Render("opencode 配置管理工具 · 查看 / 生成 opencode.json") + "\n\n"
	for i, item := range a.menuItem {
		marker := "  "
		style := valueStyle
		if i == a.menuIdx {
			marker = "▶ "
			style = cursorStyle
		}
		b += fmt.Sprintf("%s%s\n", marker, style.Render(item))
	}
	b += hintStyle.Render("\n↑/↓ 选择 · enter 确认 · q 退出")
	return lipgloss.NewStyle().Padding(1, 2).Render(b)
}

// messages
type modelsLoadedMsg struct {
	models map[string]models.Model
	err    error
}

type configLoadedMsg struct {
	loaded []config.Loaded
	merged map[string]any
	err    error
}

func loadModels() tea.Msg {
	m, err := models.Fetch()
	return modelsLoadedMsg{models: m, err: err}
}

func loadConfig() tea.Msg {
	loaded, err := config.LoadExisting()
	if err != nil {
		return configLoadedMsg{err: err}
	}
	return configLoadedMsg{loaded: loaded, merged: config.Merged(loaded)}
}

// extractEnabledProviders 从合并后的配置中提取 enabled_providers 字符串列表。
func extractEnabledProviders(merged map[string]any) []string {
	raw, ok := merged["enabled_providers"].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// extractExistingProviders 从合并后的配置中提取所有已定义的 provider 名（provider 块的 key）。
func extractExistingProviders(merged map[string]any) []string {
	provs, ok := merged["provider"].(map[string]any)
	if !ok {
		return nil
	}
	var out []string
	for k := range provs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
