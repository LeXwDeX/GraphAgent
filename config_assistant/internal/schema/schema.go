package schema

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed config.json
var configSchemaBytes []byte

// ConfigSchema 是 GraphAgent 配置 schema 的内嵌副本，用于离线校验生成的配置。
var ConfigSchema json.RawMessage

func init() {
	ConfigSchema = json.RawMessage(configSchemaBytes)
}

// Validate 对生成的 GraphAgent 配置做基本的顶层键校验。
// 它比对 config schema 的 properties 白名单，拒绝未识别的顶层键。
func Validate(config map[string]any) error {
	var schema struct {
		Defs struct {
			Config struct {
				Properties    map[string]any `json:"properties"`
				AddlProps     bool           `json:"additionalProperties"`
				PropertyNames []string       `json:"-"`
			} `json:"Config"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(configSchemaBytes, &schema); err != nil {
		return fmt.Errorf("解析内嵌 schema 失败: %w", err)
	}

	allowed := map[string]bool{}
	for k := range schema.Defs.Config.Properties {
		allowed[k] = true
	}

	for key := range config {
		if !allowed[key] && key != "$schema" {
			return fmt.Errorf("未识别的顶层键 %q（GraphAgent 配置严格禁止额外属性）", key)
		}
	}
	return nil
}

// AllowedTopLevelKeys 返回 schema 允许的所有顶层键，供 TUI 提示使用。
func AllowedTopLevelKeys() []string {
	var schema struct {
		Defs struct {
			Config struct {
				Properties map[string]any `json:"properties"`
			} `json:"Config"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(configSchemaBytes, &schema); err != nil {
		return nil
	}
	keys := make([]string, 0, len(schema.Defs.Config.Properties))
	for k := range schema.Defs.Config.Properties {
		keys = append(keys, k)
	}
	return keys
}
