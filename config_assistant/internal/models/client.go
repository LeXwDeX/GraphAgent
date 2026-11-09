// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

package models

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	sourceURL = "https://models.dev/api.json"
	cacheFile = "ocfg-api.json"
	ttl       = 24 * time.Hour
)

var client = &http.Client{Timeout: 30 * time.Second}

// Fetch 获取模型列表，优先用未过期的本地缓存，否则联网拉取。
// 联网失败时若存在旧缓存则降级返回，否则报错。
func Fetch() (map[string]Model, error) {
	cachePath, err := cacheLocation()
	if err != nil {
		return fetchRemote()
	}

	if fresh, data := readCacheIfFresh(cachePath); fresh {
		if parsed, parseErr := parseModels(data); parseErr == nil {
			return parsed, nil
		}
	}

	data, err := download(cachePath)
	if err != nil {
		if stale, sd := readCacheAnyAge(cachePath); stale {
			return parseModels(sd)
		}
		return nil, err
	}
	return parseModels(data)
}

func fetchRemote() (map[string]Model, error) {
	resp, err := client.Get(sourceURL)
	if err != nil {
		return nil, fmt.Errorf("无法连接 models.dev: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models.dev 返回 %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseModels(data)
}

func download(cachePath string) ([]byte, error) {
	resp, err := client.Get(sourceURL)
	if err != nil {
		return nil, fmt.Errorf("拉取 models.dev 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models.dev 返回 %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if _, err := parseModels(data); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return nil, err
	}
	temp, err := os.CreateTemp(filepath.Dir(cachePath), ".ocfg-api-*")
	if err != nil {
		return nil, err
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if _, err := temp.Write(data); err != nil {
		return nil, err
	}
	if err := temp.Sync(); err != nil {
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tempPath, cachePath); err != nil {
		return nil, err
	}
	return data, nil
}

// parseModels 解析 models.dev/api.json（以 provider 为键的嵌套结构），
// 展平为以 "provider/model_id" 为键的扁平 map。
func parseModels(data []byte) (map[string]Model, error) {
	var providers map[string]providerEntry
	if err := json.Unmarshal(data, &providers); err != nil {
		return nil, fmt.Errorf("解析模型数据失败: %w", err)
	}
	out := make(map[string]Model)
	for provID, prov := range providers {
		for modelID, m := range prov.Models {
			fullID := provID + "/" + modelID
			m.ID = fullID
			out[fullID] = m
		}
	}
	return out, nil
}

// providerEntry 对应 api.json 中每个 provider 的结构。
type providerEntry struct {
	Name   string           `json:"name"`
	Models map[string]Model `json:"models"`
}

// Sorted 返回按 ID 排序的模型切片，便于列表渲染。
func Sorted(m map[string]Model) []Model {
	out := make([]Model, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Filter 按关键词和能力过滤模型。keywords 空则返回全部。
// caps 要求模型必须同时具备列出的能力（reasoning/tool_call/attachment）。
func Filter(all []Model, keywords string, requireReasoning, requireTool, requireImage bool) []Model {
	kw := strings.ToLower(strings.TrimSpace(keywords))
	var out []Model
	for _, m := range all {
		if requireReasoning && !m.Reasoning {
			continue
		}
		if requireTool && !m.ToolCall {
			continue
		}
		if requireImage && !m.Attachment {
			continue
		}
		if kw == "" {
			out = append(out, m)
			continue
		}
		if strings.Contains(strings.ToLower(m.ID), kw) ||
			strings.Contains(strings.ToLower(m.Name), kw) ||
			strings.Contains(strings.ToLower(m.Description), kw) ||
			strings.Contains(strings.ToLower(m.Family), kw) {
			out = append(out, m)
		}
	}
	return out
}

func cacheLocation() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, cacheFile), nil
}

func readCacheIfFresh(path string) (bool, []byte) {
	info, err := os.Stat(path)
	if err != nil {
		return false, nil
	}
	if time.Since(info.ModTime()) > ttl {
		return false, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, nil
	}
	return true, data
}

func readCacheAnyAge(path string) (bool, []byte) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, nil
	}
	return true, data
}
