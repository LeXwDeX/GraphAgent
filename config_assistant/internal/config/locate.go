package config

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
)

// Layer 标识配置来源的层级，对应 GraphAgent 的优先级顺序。
type Layer int

const (
	LayerManaged Layer = iota // 管理员强制（最高优先级中的文件层）
	LayerInline               // GRAPHAGENT_CONFIG_CONTENT 环境变量
	LayerProject              // 项目根 graphagent.json
	LayerCustom               // GRAPHAGENT_CONFIG 环境变量
	LayerGlobal               // ~/.config/graphagent/graphagent.json
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
			result = append(result, filepath.Join("/Library/Managed Preferences", current.Username, "io.github.lexwdex.graphagent.managed.plist"))
		}
		result = append(result, "/Library/Managed Preferences/io.github.lexwdex.graphagent.managed.plist")
	}
	return append(result, configFiles(managedDir(), "graphagent.jsonc", "graphagent.json")...)
}

func ManagedPath() string {
	return filepath.Join(managedDir(), "graphagent.jsonc")
}

func managedDir() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/graphagent"
	case "windows":
		if programData := os.Getenv("ProgramData"); programData != "" {
			return filepath.Join(programData, "graphagent")
		}
		return filepath.Join(`C:\ProgramData`, "graphagent")
	default:
		return "/etc/graphagent"
	}
}

// GlobalPath 返回全局配置写入目标，优先复用已有文件。
// 当配置目录无法解析（如 HOME 缺失）时返回空字符串，调用方必须据此拒绝写入。
func GlobalPath() string {
	dir := configDir()
	if dir == "" {
		return ""
	}
	for _, name := range []string{"graphagent.jsonc", "graphagent.json", "config.json"} {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(dir, "graphagent.jsonc")
}

func configDir() string {
	if dir := strings.TrimSpace(os.Getenv("GRAPHAGENT_CONFIG_DIR")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "graphagent")
}

// ProjectPath returns the project-layer write target, or an empty string when
// no writable project root exists. The project layer is the single
// `<root>/.agents/` directory; the shared settings file is its canonical target.
func ProjectPath() string {
	root := projectRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, projectDirName, "settings.json")
}

func globalConfigPaths() []string {
	return configFiles(configDir(), "graphagent.jsonc", "graphagent.json", "config.json")
}

func projectConfigPaths() []string {
	root := projectRoot()
	if root == "" {
		return nil
	}
	return configFiles(filepath.Join(root, projectDirName), "settings.json", "settings.local.json")
}

const projectDirName = ".agents"

// projectRoot resolves the single project layer: the nearest directory at or
// above the working directory that holds `.agents/`, bounded by the git
// toplevel. `$HOME` and the filesystem root never become project roots. Without
// a marker a git repository falls back to its toplevel and everything else to
// the working directory — the same rule the runtime applies.
func projectRoot() string {
	start, err := os.Getwd()
	if err != nil {
		return ""
	}
	start = filepath.Clean(start)
	home := ""
	if resolved, err := os.UserHomeDir(); err == nil {
		home = filepath.Clean(resolved)
	}
	root := fsRoot(start)
	toplevel := gitToplevel(start)
	upper := toplevel
	if upper == "" {
		if home != "" && within(start, home) {
			upper = home
		} else {
			upper = root
		}
	}

	for current := start; ; {
		if !samePath(current, home) && !samePath(current, root) && isDirectory(filepath.Join(current, projectDirName)) {
			return current
		}
		if samePath(current, upper) {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	if toplevel != "" {
		return toplevel
	}
	if samePath(start, home) {
		return ""
	}
	return start
}

func gitToplevel(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	toplevel := strings.TrimSpace(string(output))
	if toplevel == "" {
		return ""
	}
	return filepath.Clean(toplevel)
}

func fsRoot(path string) string {
	for {
		parent := filepath.Dir(path)
		if parent == path {
			return path
		}
		path = parent
	}
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func within(candidate, parent string) bool {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func configFiles(dir string, names ...string) []string {
	if len(names) == 0 {
		names = []string{"graphagent.jsonc", "graphagent.json"}
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
