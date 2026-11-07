package config

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Loaded 表示已从磁盘读取并解析的一份配置。
type Loaded struct {
	Source Source
	Data   map[string]any
}

// LoadExisting 读取所有存在的配置源，按优先级从高到低返回。
func LoadExisting() ([]Loaded, error) {
	var result []Loaded
	for _, src := range Discover() {
		if src.Err != nil {
			return nil, fmt.Errorf("%s: %w", src.Label, src.Err)
		}
		if !src.Exists {
			continue
		}
		var data map[string]any
		var err error
		if src.Layer == LayerInline {
			data, err = parseJSONC([]byte(os.Getenv("GRAPHAGENT_CONFIG_CONTENT")))
		} else if strings.HasSuffix(src.Path, ".plist") {
			data, err = readManagedPlist(src.Path)
		} else {
			data, err = readFile(src.Path)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", src.Label, err)
		}
		data, err = substituteVars(data, src.Path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", src.Label, err)
		}
		result = append(result, Loaded{Source: src, Data: data})
	}
	return result, nil
}

func readManagedPlist(path string) (map[string]any, error) {
	raw, err := exec.Command("plutil", "-convert", "json", "-o", "-", path).Output()
	if err != nil {
		return nil, fmt.Errorf("读取 managed plist 失败: %w", err)
	}
	data, err := parseJSONC(raw)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{
		"PayloadDisplayName",
		"PayloadIdentifier",
		"PayloadType",
		"PayloadUUID",
		"PayloadVersion",
		"_manualProfile",
	} {
		delete(data, key)
	}
	return data, nil
}

// Merged 把多份配置按 GraphAgent 语义合并（低优先级在前，高优先级覆盖）。
// 调用方需自行保证传入顺序。
func Merged(loaded []Loaded) map[string]any {
	merged := map[string]any{}
	// loaded 是高→低优先级，合并时从低到高覆盖
	for i := len(loaded) - 1; i >= 0; i-- {
		merged = deepMerge(merged, loaded[i].Data)
	}
	return merged
}

// RedactSensitive 返回用于展示的配置副本，不暴露 API key 等凭证。
func RedactSensitive(data map[string]any) map[string]any {
	value, _ := redactValue(data, "").(map[string]any)
	return value
}

func redactValue(value any, key string) any {
	if sensitiveKey(key) {
		if s, ok := value.(string); ok && (strings.HasPrefix(s, "{env:") || strings.HasPrefix(s, "{file:")) {
			return s
		}
		return "***"
	}
	switch value := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for childKey, child := range value {
			out[childKey] = redactValue(child, childKey)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, child := range value {
			out[i] = redactValue(child, "")
		}
		return out
	default:
		return value
	}
}

func sensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
	return strings.Contains(normalized, "apikey") || strings.Contains(normalized, "password") ||
		strings.Contains(normalized, "secret") || strings.HasSuffix(normalized, "token") ||
		normalized == "authorization"
}

func readFile(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseJSONC(raw)
}

func deepMerge(dst, src map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range dst {
		out[k] = v
	}
	for k, v := range src {
		if existing, ok := out[k]; ok {
			if em, ok1 := existing.(map[string]any); ok1 {
				if vm, ok2 := v.(map[string]any); ok2 {
					out[k] = deepMerge(em, vm)
					continue
				}
			}
		}
		out[k] = v
	}
	return out
}

var (
	envVarRe  = regexp.MustCompile(`\{env:([A-Za-z_][A-Za-z0-9_]*)\}`)
	fileVarRe = regexp.MustCompile(`\{file:([^}]+)\}`)
)

func substituteVars(data map[string]any, configPath string) (map[string]any, error) {
	baseDir := filepath.Dir(configPath)
	value, err := walkSub(data, baseDir)
	if err != nil {
		return nil, err
	}
	return value.(map[string]any), nil
}

func walkSub(v any, baseDir string) (any, error) {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			replaced, err := walkSub(val, baseDir)
			if err != nil {
				return nil, err
			}
			out[k] = replaced
		}
		return out, nil
	case []any:
		for i := range t {
			replaced, err := walkSub(t[i], baseDir)
			if err != nil {
				return nil, err
			}
			t[i] = replaced
		}
		return t, nil
	case string:
		return replaceInString(t, baseDir)
	default:
		return v, nil
	}
}

func replaceInString(s, baseDir string) (string, error) {
	var fileErr error
	s = envVarRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := envVarRe.FindStringSubmatch(m)
		if len(sub) < 2 {
			return m
		}
		return os.Getenv(sub[1])
	})
	s = fileVarRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := fileVarRe.FindStringSubmatch(m)
		if len(sub) < 2 {
			return m
		}
		p := sub[1]
		if strings.HasPrefix(p, "~") {
			home, _ := os.UserHomeDir()
			p = filepath.Join(home, p[1:])
		} else if !filepath.IsAbs(p) {
			p = filepath.Join(baseDir, p)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			fileErr = fmt.Errorf("读取文件引用 %s 失败: %w", p, err)
			return m
		}
		return strings.TrimSpace(string(b))
	})
	return s, fileErr
}

// parseJSONC 解析 JSONC（支持 // 行注释、/* 块注释 */、尾逗号）。
func parseJSONC(raw []byte) (map[string]any, error) {
	cleaned := stripTrailingCommas(stripJSONC(raw))
	var data map[string]any
	if err := json.Unmarshal([]byte(cleaned), &data); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w", err)
	}
	if data == nil {
		data = map[string]any{}
	}
	return data, nil
}

func stripTrailingCommas(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inStr := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(s) {
				b.WriteByte(s[i+1])
				i++
				continue
			}
			if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			b.WriteByte(c)
			continue
		}
		if c != ',' {
			b.WriteByte(c)
			continue
		}
		j := i + 1
		for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\r' || s[j] == '\n') {
			j++
		}
		if j < len(s) && (s[j] == '}' || s[j] == ']') {
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

func stripJSONC(raw []byte) string {
	s := string(raw)
	var b strings.Builder
	b.Grow(len(s))
	inStr := false
	var strDelim byte
	i := 0
	for i < len(s) {
		c := s[i]
		if inStr {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(s) {
				b.WriteByte(s[i+1])
				i += 2
				continue
			}
			if c == strDelim {
				inStr = false
			}
			i++
			continue
		}
		switch {
		case c == '"' || c == '\'':
			inStr = true
			strDelim = c
			b.WriteByte(c)
			i++
		case c == '/' && i+1 < len(s) && s[i+1] == '/':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			i += 2
			for i+1 < len(s) && !(s[i] == '*' && s[i+1] == '/') {
				i++
			}
			i += 2
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}
