// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package tui

import (
	"encoding/json"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/config"
	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/models"
)

// generatePreview 用当前选中的模型 + provider 选项 + 目标映射构建预览产物。
func (a *app) generatePreview() {
	a.genPath = ""
	a.genBytes = nil
	a.genMerged = nil
	a.genSource = nil
	a.genSourceOK = false
	a.genErr = ""
	a.changes = nil
	var sel []models.Model
	for _, m := range a.allModels {
		if a.selected[m.ID] {
			sel = append(sel, m)
		}
	}
	mainID := ""
	if len(sel) > 0 {
		mainID = sel[0].ID
	}

	opts := map[string]config.ProviderOpts{}
	for _, p := range a.provOrder {
		opts[p] = config.ProviderOpts{
			BaseURL: a.baseURLs[p],
			APIKey:  a.apiKeys[p],
		}
	}

	target := config.TargetGlobal
	if a.step1Idx == 1 {
		target = config.TargetProject
	}
	source, sourceOK, snapshotErr := config.TargetSnapshot(target)
	if snapshotErr != nil {
		a.genErr = snapshotErr.Error()
		return
	}
	a.genSource = source
	a.genSourceOK = sourceOK

	// 所有模型统一指向 step2 选定的 targetProvider
	targetProviderMap := map[string]string{}
	for _, m := range sel {
		targetProviderMap[m.ID] = a.targetProvider
	}

	// 检测同后缀模型名冲突（不同 provider 的同名模型落到同一目标 provider）
	seenNames := map[string]string{} // modelName → first ID
	a.dupes = nil
	for _, m := range sel {
		name := m.ModelName()
		if prev, exists := seenNames[name]; exists {
			a.dupes = append(a.dupes, prev+" 与 "+m.ID+" 同名 \""+name+"\"")
		} else {
			seenNames[name] = m.ID
		}
	}

	// 冲突检测（目标文件中已存在的同名模型）
	conflicts, detectErr := config.DetectConflicts(target, sel, targetProviderMap)
	a.conflicts = nil
	if detectErr != nil {
		a.genErr = detectErr.Error()
		return
	}
	a.conflicts = conflicts

	gen := config.GenerateFromModels(config.GenRequest{
		Selected:       sel,
		MainModelID:    mainID,
		ProviderOpts:   opts,
		TargetProvider: targetProviderMap,
	})
	policy := make(map[string]any, len(a.merged)+1)
	for key, value := range a.merged {
		policy[key] = value
	}
	if model, ok := gen["model"]; ok {
		policy["model"] = model
	}
	if check := config.CheckProviders(policy); check.HasProblems() {
		a.genErr = check.Issues[0].Message
		return
	}

	path, bytes, err := config.MergeIntoExisting(target, gen)
	a.genPath = path
	a.genBytes = bytes
	a.genMerged = mergedMap(bytes)
	a.genErr = ""
	if err != nil {
		a.genErr = err.Error()
		a.genBytes = nil
		return
	}

	changes, diffErr := config.DiffConfig(target, gen)
	if diffErr != nil {
		a.genErr = diffErr.Error()
		a.changes = nil
		return
	}
	a.changes = changes
}

func mergedMap(bytes []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(bytes, &m); err != nil {
		return nil
	}
	return m
}
