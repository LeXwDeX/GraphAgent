// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package models

import (
	"fmt"
	"strings"
)

// Model 对应 models.dev/api.json 中每个模型的富元数据。
type Model struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Family      string     `json:"family"`
	Attachment  bool       `json:"attachment"`
	Reasoning   bool       `json:"reasoning"`
	ToolCall    bool       `json:"tool_call"`
	Structured  bool       `json:"structured_output"`
	Temperature bool       `json:"temperature"`
	ReleaseDate string     `json:"release_date"`
	LastUpdated string     `json:"last_updated"`
	OpenWeights bool       `json:"open_weights"`
	Modalities  Modalities `json:"modalities"`
	Limit       Limit      `json:"limit"`
	Cost        Cost       `json:"cost"`
}

// Cost 描述模型的定价（每百万 token 美元）。部分字段可能为零值（未提供）。
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

// Modalities 描述模型支持的输入输出模态。
type Modalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// Limit 描述模型的上下文和输出 token 上限。
type Limit struct {
	Context int `json:"context"`
	Input   int `json:"input"`
	Output  int `json:"output"`
}

// Provider 从 ID（格式 provider/model）中解析出 provider 部分。
func (m Model) Provider() string {
	if i := strings.IndexByte(m.ID, '/'); i > 0 {
		return m.ID[:i]
	}
	return m.ID
}

// ModelName 从 ID 中解析出 model 部分。
func (m Model) ModelName() string {
	if i := strings.IndexByte(m.ID, '/'); i > 0 {
		return m.ID[i+1:]
	}
	return m.ID
}

// ContextK 返回以 k 为单位的上下文大小，用于紧凑显示。
func (m Model) ContextK() string {
	return formatThousands(m.Limit.Context)
}

// OutputK 返回以 k 为单位的输出上限。
func (m Model) OutputK() string {
	return formatThousands(m.Limit.Output)
}

// HasCost 返回 true 当模型携带了非零的定价数据。
func (m Model) HasCost() bool {
	return m.Cost.Input > 0 || m.Cost.Output > 0
}

// CostInputStr 返回格式化的输入价格，无数据时返回 "-"。
func (m Model) CostInputStr() string {
	if m.Cost.Input > 0 {
		return fmt.Sprintf("$%.2f", m.Cost.Input)
	}
	return "-"
}

// CostOutputStr 返回格式化的输出价格，无数据时返回 "-"。
func (m Model) CostOutputStr() string {
	if m.Cost.Output > 0 {
		return fmt.Sprintf("$%.2f", m.Cost.Output)
	}
	return "-"
}

func formatThousands(n int) string {
	if n <= 0 {
		return "-"
	}
	if n >= 1000000 {
		return strings.TrimSuffix(strings.TrimRight(
			fmt.Sprintf("%.1fM", float64(n)/1000000), "0"), ".")
	}
	if n >= 1000 {
		return strings.TrimSuffix(strings.TrimRight(
			fmt.Sprintf("%.0fK", float64(n)/1000), "0"), ".")
	}
	return intToStr(n)
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
