// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/models"
)

// WriteTarget 是生成配置的写入目标。
type WriteTarget int

const (
	TargetGlobal  WriteTarget = iota // ~/.config/graphagent/graphagent.json
	TargetProject                    // <root>/.agents/settings.json
)

// ProviderOpts 是单个 provider 的自定义连接选项。空值表示该项不写入。
type ProviderOpts struct {
	BaseURL string // 自定义 API 端点
	APIKey  string // API 密钥（建议用 {env:XXX} 或 {file:path} 引用）
}

// GenRequest 描述一次模型配置生成的完整请求。
type GenRequest struct {
	Selected       []models.Model          // 选中的模型
	MainModelID    string                  // 主模型 ID（写入顶层 model）；若指向被跳过的模型则忽略
	ProviderOpts   map[string]ProviderOpts // 按 provider 名注入 options（key 为目标 provider 名）
	TargetProvider map[string]string       // 模型 ID -> 目标 provider 名（为空则用模型原始 provider）
	SkipModels     map[string]bool         // 要跳过的模型 ID（冲突时选择"保留原参数"）
}

// ModelConflict 表示目标文件中已存在的同名模型。
type ModelConflict struct {
	Provider string // 目标 provider 名
	Model    string // 模型名（不含 provider 前缀）
	Source   string // 原始模型 ID（provider/model），用于定位
}

// DetectConflicts 检查目标文件已有的 provider.models 中是否包含将要写入的模型。
// 返回冲突列表；调用方据此决定覆盖或跳过。
func DetectConflicts(target WriteTarget, selected []models.Model, targetProvider map[string]string) ([]ModelConflict, error) {
	path, err := targetPath(target)
	if err != nil {
		return nil, err
	}
	existing, err := readExistingProviders(path)
	if err != nil {
		// 目标文件存在但解析失败：必须报错，防止误判为"无冲突"
		return nil, fmt.Errorf("读取目标配置 %s 失败: %w", path, err)
	}
	if existing == nil {
		// 文件不存在，无冲突
		return nil, nil
	}
	var conflicts []ModelConflict
	for _, m := range selected {
		prov := targetProvider[m.ID]
		if prov == "" {
			prov = m.Provider()
		}
		name := m.ModelName()
		if modelsBlock, ok := existing[prov].(map[string]any); ok {
			if mm, ok := modelsBlock["models"].(map[string]any); ok {
				if _, exists := mm[name]; exists {
					conflicts = append(conflicts, ModelConflict{
						Provider: prov,
						Model:    name,
						Source:   m.ID,
					})
				}
			}
		}
	}
	return conflicts, nil
}

func readExistingProviders(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	parsed, err := parseJSONC(raw)
	if err != nil {
		return nil, err
	}
	provs, _ := parsed["provider"].(map[string]any)
	return provs, nil
}

// TargetProviderHasOptions 检查指定的目标文件中，某个 provider 是否已有 options（baseURL/apiKey）。
// 与读 merged 视图不同，这里只读将要写入的那个文件。
func TargetProviderHasOptions(target WriteTarget, prov string) bool {
	path, err := targetPath(target)
	if err != nil {
		return false
	}
	existing, err := readExistingProviders(path)
	if err != nil || existing == nil {
		return false
	}
	entry, ok := existing[prov].(map[string]any)
	if !ok {
		return false
	}
	opts, ok := entry["options"].(map[string]any)
	if !ok {
		return false
	}
	_, hasBase := opts["baseURL"]
	_, hasKey := opts["apiKey"]
	return hasBase || hasKey
}

// GenerateFromModels 把选中的模型组装成 GraphAgent provider 配置块。
// 返回的 map 可合并进现有配置。
func GenerateFromModels(req GenRequest) map[string]any {
	providerBlock := map[string]any{}
	for _, m := range selected(req) {
		if req.SkipModels != nil && req.SkipModels[m.ID] {
			continue
		}
		// 解析目标 provider：优先用户指定，否则用模型原始 provider
		prov := req.TargetProvider[m.ID]
		if prov == "" {
			prov = m.Provider()
		}
		name := m.ModelName()
		modelBlock := map[string]any{
			"name":       m.Name,
			"attachment": m.Attachment,
			"reasoning":  m.Reasoning,
			"tool_call":  m.ToolCall,
		}
		if m.Limit.Context > 0 || m.Limit.Output > 0 {
			lim := map[string]any{
				"context": m.Limit.Context,
				"output":  m.Limit.Output,
			}
			if m.Limit.Input > 0 {
				lim["input"] = m.Limit.Input
			}
			modelBlock["limit"] = lim
		}
		if m.HasCost() {
			costBlock := map[string]any{
				"input":  m.Cost.Input,
				"output": m.Cost.Output,
			}
			if m.Cost.CacheRead > 0 {
				costBlock["cache_read"] = m.Cost.CacheRead
			}
			if m.Cost.CacheWrite > 0 {
				costBlock["cache_write"] = m.Cost.CacheWrite
			}
			modelBlock["cost"] = costBlock
		}
		if len(m.Modalities.Input) > 0 || len(m.Modalities.Output) > 0 {
			mod := map[string]any{}
			if len(m.Modalities.Input) > 0 {
				mod["input"] = m.Modalities.Input
			}
			if len(m.Modalities.Output) > 0 {
				mod["output"] = m.Modalities.Output
			}
			modelBlock["modalities"] = mod
		}
		if m.ReleaseDate != "" {
			modelBlock["release_date"] = m.ReleaseDate
		}

		provEntry, ok := providerBlock[prov].(map[string]any)
		if !ok {
			provEntry = map[string]any{}
			providerBlock[prov] = provEntry
		}
		// 注入 options（baseURL / apiKey），按目标 provider 名查找
		if po, has := req.ProviderOpts[prov]; has && (po.BaseURL != "" || po.APIKey != "") {
			optBlock := map[string]any{}
			if po.BaseURL != "" {
				optBlock["baseURL"] = po.BaseURL
			}
			if po.APIKey != "" {
				optBlock["apiKey"] = po.APIKey
			}
			provEntry["options"] = optBlock
		}
		mods, ok := provEntry["models"].(map[string]any)
		if !ok {
			mods = map[string]any{}
			provEntry["models"] = mods
		}
		mods[name] = modelBlock
	}

	result := map[string]any{}
	if req.MainModelID != "" && (req.SkipModels == nil || !req.SkipModels[req.MainModelID]) {
		mainModelID := req.MainModelID
		for _, m := range req.Selected {
			if m.ID != req.MainModelID {
				continue
			}
			provider := req.TargetProvider[m.ID]
			if provider == "" {
				provider = m.Provider()
			}
			mainModelID = provider + "/" + m.ModelName()
			break
		}
		result["model"] = mainModelID
	}
	if len(providerBlock) > 0 {
		result["provider"] = providerBlock
	}
	if schema, _ := result["$schema"].(string); schema == "" {
		result["$schema"] = "https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json"
	}
	return result
}

// selected 返回请求中的模型列表（保留原签名兼容性，内部用）。
func selected(req GenRequest) []models.Model {
	return req.Selected
}

// MergeIntoExisting 把新生成的配置块合并进目标文件已有的配置。
// 目标文件不存在则创建新文件。
// 若目标文件存在但 JSON 解析失败，返回错误以防止破坏用户原有配置。
func MergeIntoExisting(target WriteTarget, generated map[string]any) (string, []byte, error) {
	path, err := targetPath(target)
	if err != nil {
		return "", nil, err
	}

	existing := map[string]any{}
	if raw, readErr := os.ReadFile(path); readErr == nil {
		parsed, parseErr := parseJSONC(raw)
		if parseErr != nil {
			return path, nil, fmt.Errorf(
				"目标文件 %s 已存在但解析失败，已中止写入以防覆盖损坏: %w\n"+
					"请先修复该文件的 JSON 语法错误（可用 `graphagent debug config` 或 JSON 校验工具检查）",
				path, parseErr)
		}
		existing = parsed
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return path, nil, fmt.Errorf("读取目标配置 %s 失败: %w", path, readErr)
	}

	merged := deepMerge(existing, generated)

	out, err := marshalOrdered(merged)
	if err != nil {
		return path, nil, err
	}
	return path, out, nil
}

// WriteFile 把内容写入指定路径，自动创建父目录。
// 若目标文件已存在，写入前先备份到 <path>.bak.YYYYMMDD-HHMMSS。
// 返回备份文件路径（无备份时为空）。
func WriteFile(path string, data []byte) (string, error) {
	return writeFile(path, data, nil, false, false)
}

// TargetSnapshot reads the target file for optimistic concurrency checks.
func TargetSnapshot(target WriteTarget) ([]byte, bool, error) {
	path, err := targetPath(target)
	if err != nil {
		return nil, false, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("读取目标配置 %s 失败: %w", path, err)
	}
	return raw, true, nil
}

// WriteFileIfUnchanged writes only if the target still matches its preview snapshot.
func WriteFileIfUnchanged(path string, data, expected []byte, expectedExists bool) (string, error) {
	return writeFile(path, data, expected, expectedExists, true)
}

func writeFile(path string, data, expected []byte, expectedExists, checkExpected bool) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	release, err := acquireWriteLock(path)
	if err != nil {
		return "", err
	}
	defer release()

	backup := ""
	raw, err := os.ReadFile(path)
	if checkExpected {
		if expectedExists {
			if err != nil {
				return "", fmt.Errorf("目标配置在确认前已消失或不可读: %w", err)
			}
			if !bytes.Equal(raw, expected) {
				return "", fmt.Errorf("目标配置在确认前已被修改，请重新生成预览")
			}
		} else if err == nil {
			return "", fmt.Errorf("目标配置在确认前已创建，请重新生成预览")
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("读取目标配置失败: %w", err)
		}
	}
	if err == nil {
		backup = backupPath(path)
		if err := os.WriteFile(backup, raw, 0o600); err != nil {
			return "", fmt.Errorf("备份失败，已中止写入以防数据丢失: %w", err)
		}
		if err := os.Chmod(backup, 0o600); err != nil {
			return "", fmt.Errorf("备份权限设置失败，已中止写入: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("读取现有配置失败，已中止写入: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".graphagent-config-*")
	if err != nil {
		return backup, err
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o600); err != nil {
		return backup, err
	}
	if _, err := temp.Write(data); err != nil {
		return backup, err
	}
	if err := temp.Sync(); err != nil {
		return backup, err
	}
	if err := temp.Close(); err != nil {
		return backup, err
	}
	if err := replaceFile(tempPath, path); err != nil {
		return backup, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return backup, err
	}
	return backup, nil
}

func acquireWriteLock(path string) (func(), error) {
	lockPath := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			if closeErr := lock.Close(); closeErr != nil {
				_ = os.Remove(lockPath)
				return func() {}, closeErr
			}
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return func() {}, fmt.Errorf("创建配置写入锁失败: %w", err)
		}
		if time.Now().After(deadline) {
			return func() {}, fmt.Errorf("等待配置写入锁超时: %s", lockPath)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func backupPath(path string) string {
	// 精确到毫秒，避免同一秒多次写入时备份文件名冲突
	return path + ".bak." + time.Now().Format("20060102-150405.000")
}

// ChangeKind 描述一个配置项的变更类型。
type ChangeKind int

const (
	ChangeAdd    ChangeKind = iota // 新增 KEY（目标文件没有）
	ChangeModify                   // 修改已有 KEY 的值
)

// Change 描述一个顶层配置项的变更。
type Change struct {
	Key     string
	Kind    ChangeKind
	Summary string // 人类可读的变更摘要
}

// DiffConfig 对比目标文件现有配置与即将写入的配置，返回顶层变更清单。
// 调用方据此向用户显性展示每一项变更。
func DiffConfig(target WriteTarget, generated map[string]any) ([]Change, error) {
	path, err := targetPath(target)
	if err != nil {
		return nil, err
	}
	existing := map[string]any{}
	if raw, readErr := os.ReadFile(path); readErr == nil {
		parsed, parseErr := parseJSONC(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("目标文件 %s 解析失败: %w", path, parseErr)
		}
		existing = parsed
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return nil, fmt.Errorf("读取目标配置 %s 失败: %w", path, readErr)
	}

	var changes []Change
	for k, newVal := range generated {
		if k == "$schema" {
			continue
		}
		oldVal, exists := existing[k]
		if !exists {
			changes = append(changes, Change{
				Key:     k,
				Kind:    ChangeAdd,
				Summary: summarizeValue(k, newVal),
			})
		} else if !valuesEqual(oldVal, newVal) {
			changes = append(changes, Change{
				Key:     k,
				Kind:    ChangeModify,
				Summary: summarizeValue(k, newVal),
			})
		}
	}
	return changes, nil
}

func summarizeValue(key string, v any) string {
	switch key {
	case "model":
		if s, ok := v.(string); ok {
			return "主模型设为 " + s
		}
	case "provider":
		if provs, ok := v.(map[string]any); ok {
			names := make([]string, 0, len(provs))
			for p := range provs {
				names = append(names, p)
			}
			return "provider 块涉及: " + strings.Join(sortStrings(names), ", ")
		}
	}
	return formatJSONValue(v)
}

func formatJSONValue(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	s := string(b)
	if len(s) > 60 {
		return s[:57] + "..."
	}
	return s
}

func valuesEqual(a, b any) bool {
	aj, _ := json.Marshal(a)
	bj, _ := json.Marshal(b)
	return string(aj) == string(bj)
}

func targetPath(t WriteTarget) (string, error) {
	switch t {
	case TargetGlobal:
		p := GlobalPath()
		if p == "" {
			return "", fmt.Errorf("无法解析全局配置目录（HOME 未设置），拒绝写入")
		}
		return p, nil
	case TargetProject:
		p := ProjectPath()
		if p == "" {
			return "", fmt.Errorf("无法解析项目根（项目根为 $HOME 或无可用目录），拒绝写入")
		}
		return p, nil
	default:
		return "", fmt.Errorf("未知写入目标")
	}
}

func marshalOrdered(m map[string]any) ([]byte, error) {
	return jsonMarshalSorted(m)
}

func jsonMarshalSorted(m map[string]any) ([]byte, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		if k == "$schema" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.WriteString("{\n")
	if schema, ok := m["$schema"]; ok {
		s, _ := json.Marshal(schema)
		b.WriteString("  \"$schema\": ")
		b.Write(s)
		b.WriteString(",\n")
	}
	for i, k := range keys {
		kb, _ := json.Marshal(k)
		b.WriteString("  ")
		b.Write(kb)
		b.WriteString(": ")
		vb, err := marshalValue(m[k], 1)
		if err != nil {
			return nil, err
		}
		b.Write(vb)
		if i < len(keys)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return []byte(b.String()), nil
}

func marshalValue(v any, indent int) ([]byte, error) {
	switch t := v.(type) {
	case map[string]any:
		if len(t) == 0 {
			return []byte("{}"), nil
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		b.WriteString("{\n")
		for i, k := range keys {
			for s := 0; s < indent+1; s++ {
				b.WriteString("  ")
			}
			kb, _ := json.Marshal(k)
			b.Write(kb)
			b.WriteString(": ")
			vb, err := marshalValue(t[k], indent+1)
			if err != nil {
				return nil, err
			}
			b.Write(vb)
			if i < len(keys)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		for s := 0; s < indent; s++ {
			b.WriteString("  ")
		}
		b.WriteString("}")
		return []byte(b.String()), nil
	default:
		return json.Marshal(v)
	}
}
