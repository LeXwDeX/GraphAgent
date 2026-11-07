package config

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
)

// Layer 标识配置来源的层级，对应 opencode 的优先级顺序。
type Layer int

const (
	LayerManaged Layer = iota // 管理员强制（最高优先级中的文件层）
	LayerInline               // GRAPHAGENT_CONFIG_CONTENT 环境变量
	LayerProject              // 项目根 opencode.json
	LayerCustom               // GRAPHAGENT_CONFIG 环境变量
	LayerGlobal               // ~/.config/opencode/opencode.json
)

// Source 描述一个配置来源的位置和状态。
type Source struct {
	Layer  Layer
	Label  string // 显示名
	Path   string // 文件路径（inline 层为空）
	Exists bool   // 文件是否存在 / 内容是否非空
	Err    error  // 检查来源时发生的非 NotExist 错误
}

// Discover 按优先级从高到低发现所有可能的配置来源。
// 调用方按返回顺序展示即可（顺序与合并方向一致）。
func Discover() []Source {
	var sources []Source

	for _, path := range managedPaths() {
		sources = append(sources, checkFile(LayerManaged, "Managed (管理员)", path))
	}
	// inline
	if content := os.Getenv("GRAPHAGENT_CONFIG_CONTENT"); strings.TrimSpace(content) != "" {
		sources = append(sources, Source{Layer: LayerInline, Label: "Inline (GRAPHAGENT_CONFIG_CONTENT)", Exists: true})
	}
	for _, path := range homeProjectPaths() {
		sources = append(sources, checkFile(LayerProject, "Home .opencode", path))
	}
	if !projectConfigDisabled() {
		for _, path := range projectConfigPaths() {
			sources = append(sources, checkFile(LayerProject, "Project (项目)", path))
		}
	}
	// custom
	if custom := os.Getenv("GRAPHAGENT_CONFIG"); custom != "" {
		sources = append(sources, checkFile(LayerCustom, "Custom (GRAPHAGENT_CONFIG)", custom))
	}
	for _, path := range globalConfigPaths() {
		sources = append(sources, checkFile(LayerGlobal, "Global (全局)", path))
	}
	return sources
}

func checkFile(layer Layer, label, path string) Source {
	_, err := os.Stat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Source{Layer: layer, Label: label, Path: path, Err: err}
	}
	return Source{Layer: layer, Label: label, Path: path, Exists: err == nil}
}

func managedPaths() []string {
	var result []string
	if runtime.GOOS == "darwin" {
		if current, err := user.Current(); err == nil {
			result = append(result, filepath.Join("/Library/Managed Preferences", current.Username, "ai.opencode.managed.plist"))
		}
		result = append(result, "/Library/Managed Preferences/ai.opencode.managed.plist")
	}
	return append(result, configFiles(managedDir(), "opencode.jsonc", "opencode.json")...)
}

func ManagedPath() string {
	return filepath.Join(managedDir(), "opencode.jsonc")
}

func managedDir() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/opencode"
	case "windows":
		if programData := os.Getenv("ProgramData"); programData != "" {
			return filepath.Join(programData, "opencode")
		}
		return filepath.Join(`C:\ProgramData`, "opencode")
	default:
		return "/etc/opencode"
	}
}

// GlobalPath 返回全局配置写入目标，优先复用已有文件。
// 当配置目录无法解析（如 HOME 缺失）时返回空字符串，调用方必须据此拒绝写入。
func GlobalPath() string {
	dir := configDir()
	if dir == "" {
		return ""
	}
	for _, name := range []string{"opencode.jsonc", "opencode.json", "config.json"} {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(dir, "opencode.jsonc")
}

func configDir() string {
	if dir := strings.TrimSpace(os.Getenv("GRAPHAGENT_CONFIG_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "opencode")
}

// ProjectPath returns the highest-priority project config file, or the default path.
func ProjectPath() string {
	if paths := projectPathCandidates(); len(paths) > 0 {
		return paths[0]
	}
	dir, err := os.Getwd()
	if err != nil {
		return "opencode.json"
	}
	return filepath.Join(dir, "opencode.json")
}

func globalConfigPaths() []string {
	return configFiles(configDir(), "opencode.jsonc", "opencode.json", "config.json")
}

func homeProjectPaths() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return configFiles(filepath.Join(home, ".opencode"))
}

func projectConfigPaths() []string {
	return projectPathCandidates()
}

func projectPathCandidates() []string {
	dirs := projectDirs()
	var result []string
	for i := len(dirs) - 1; i >= 0; i-- {
		result = append(result, configFiles(filepath.Join(dirs[i], ".opencode"))...)
	}
	for _, dir := range dirs {
		result = append(result, configFiles(dir, "opencode.jsonc", "opencode.json")...)
	}
	return result
}

func projectDirs() []string {
	dir, err := os.Getwd()
	if err != nil {
		return nil
	}
	var result []string
	for {
		result = append(result, dir)
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			break
		}
		dir = parent
	}
	return result
}

func configFiles(dir string, names ...string) []string {
	if len(names) == 0 {
		names = []string{"opencode.jsonc", "opencode.json"}
	}
	var result []string
	for _, name := range names {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil || !errors.Is(err, os.ErrNotExist) {
			result = append(result, path)
		}
	}
	return result
}

func projectConfigDisabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("GRAPHAGENT_DISABLE_PROJECT_CONFIG"))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}
