// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"fmt"
	"strings"
)

// Severity 标识问题的严重程度。
type Severity int

const (
	SeverityError   Severity = iota // 阻断：配置会导致功能不可用
	SeverityWarning                 // 冲突：disabled 与 enabled 交集
	SeverityInfo                    // 提示：非问题但值得注意
)

// Issue 描述一个检测结果。
type Issue struct {
	Severity Severity
	Category string // "model" / "small_model" / "agent" / "provider" / "conflict"
	Message  string
	Detail   string // 修复建议（可选）
}

// CheckResult 汇总所有检测问题。
type CheckResult struct {
	Issues   []Issue
	Warnings []Issue
	Infos    []Issue
}

// HasProblems 是否存在阻断级问题。
func (r CheckResult) HasProblems() bool { return len(r.Issues) > 0 }

func providerPart(modelID string) string {
	if i := strings.IndexByte(modelID, '/'); i > 0 {
		return modelID[:i]
	}
	return modelID
}

// CheckProviders 对合并后的配置做 provider 一致性检测。
func CheckProviders(merged map[string]any) CheckResult {
	var result CheckResult

	enabled := toStringSlice(merged["enabled_providers"])
	_, hasEnabled := merged["enabled_providers"]
	disabled := toSet(toStringSlice(merged["disabled_providers"]))

	// 规则 1: disabled ∩ enabled 冲突（disabled 胜出）
	if len(enabled) > 0 && len(disabled) > 0 {
		enabledSet := toSet(enabled)
		var conflicts []string
		for d := range disabled {
			if enabledSet[d] {
				conflicts = append(conflicts, d)
			}
		}
		if len(conflicts) > 0 {
			result.Warnings = append(result.Warnings, Issue{
				Severity: SeverityWarning,
				Category: "conflict",
				Message:  fmt.Sprintf("这些 provider 同时出现在 enabled 和 disabled 中（disabled 会胜出）: %s", strings.Join(sortStrings(conflicts), ", ")),
				Detail:   "从 enabled_providers 或 disabled_providers 中移除冗余项",
			})
		}
	}

	// 有 enabled_providers 白名单时：model 引用的 provider 必须在白名单内
	if hasEnabled {
		enabledSet := toSet(enabled)
		result.checkModelInWhitelist(merged, enabledSet, "model")
		result.checkModelInWhitelist(merged, enabledSet, "small_model")
		result.checkAgentsInWhitelist(merged, enabledSet)
		result.checkOrphanProviders(merged, enabledSet)
		if len(disabled) > 0 {
			result.checkModelAgainstDisabled(merged, disabled)
		}
	} else {
		result.Infos = append(result.Infos, Issue{
			Severity: SeverityInfo,
			Category: "enabled_providers",
			Message:  "未设置 enabled_providers 白名单，所有已配置凭证的 provider 都可用",
		})
		// 无白名单时仍检测：model 是否引用了被 disabled 的 provider
		if len(disabled) > 0 {
			result.checkModelAgainstDisabled(merged, disabled)
		}
	}

	return result
}

func (r *CheckResult) checkModelInWhitelist(merged map[string]any, whitelist map[string]bool, key string) {
	model, ok := merged[key].(string)
	if !ok || model == "" {
		return
	}
	p := providerPart(model)
	if !whitelist[p] {
		r.Issues = append(r.Issues, Issue{
			Severity: SeverityError,
			Category: key,
			Message:  fmt.Sprintf("%s %q 的 provider %q 不在 enabled_providers 白名单中，将不可用", key, model, p),
			Detail:   fmt.Sprintf("把 %q 加入 enabled_providers，或将 %s 改为白名单内 provider 的模型", p, key),
		})
	}
}

func (r *CheckResult) checkAgentsInWhitelist(merged map[string]any, whitelist map[string]bool) {
	agents, ok := merged["agent"].(map[string]any)
	if !ok {
		return
	}
	for name, raw := range agents {
		a, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		am, ok := a["model"].(string)
		if !ok || am == "" {
			continue
		}
		p := providerPart(am)
		if !whitelist[p] {
			r.Issues = append(r.Issues, Issue{
				Severity: SeverityError,
				Category: "agent",
				Message:  fmt.Sprintf("agent.%s.model %q 的 provider %q 不在 enabled_providers 白名单中", name, am, p),
				Detail:   fmt.Sprintf("把 %q 加入 enabled_providers，或修改该 agent 的 model", p),
			})
		}
	}
}

func (r *CheckResult) checkOrphanProviders(merged map[string]any, whitelist map[string]bool) {
	provs, ok := merged["provider"].(map[string]any)
	if !ok {
		return
	}
	var orphan []string
	for p := range provs {
		if !whitelist[p] {
			orphan = append(orphan, p)
		}
	}
	if len(orphan) > 0 {
		r.Infos = append(r.Infos, Issue{
			Severity: SeverityInfo,
			Category: "provider",
			Message:  fmt.Sprintf("provider 块已定义但因不在 enabled_providers 中而处于休眠: %s", strings.Join(sortStrings(orphan), ", ")),
			Detail:   "如需使用，加入 enabled_providers；否则可删除以精简配置",
		})
	}
}

func (r *CheckResult) checkModelAgainstDisabled(merged map[string]any, disabledSet map[string]bool) {
	for _, key := range []string{"model", "small_model"} {
		model, ok := merged[key].(string)
		if !ok || model == "" {
			continue
		}
		p := providerPart(model)
		if disabledSet[p] {
			r.Issues = append(r.Issues, Issue{
				Severity: SeverityError,
				Category: key,
				Message:  fmt.Sprintf("%s %q 的 provider %q 被 disabled_providers 禁用", key, model, p),
				Detail:   fmt.Sprintf("从 disabled_providers 移除 %q，或修改 %s", p, key),
			})
		}
	}
	agents, _ := merged["agent"].(map[string]any)
	for name, raw := range agents {
		a, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		am, ok := a["model"].(string)
		if !ok || am == "" {
			continue
		}
		p := providerPart(am)
		if disabledSet[p] {
			r.Issues = append(r.Issues, Issue{
				Severity: SeverityError,
				Category: "agent",
				Message:  fmt.Sprintf("agent.%s.model %q 的 provider %q 被 disabled_providers 禁用", name, am, p),
				Detail:   fmt.Sprintf("从 disabled_providers 移除 %q", p),
			})
		}
	}
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func toSet(items []string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, i := range items {
		m[i] = true
	}
	return m
}

func sortStrings(s []string) []string {
	out := append([]string(nil), s...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
