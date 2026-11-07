package main

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/LeXwDeX/GraphAgent/config_assistant/internal/tui"
)

const banner = `配置助手 — GraphAgent 配置管理工具

`

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-h" || os.Args[1] == "--help") {
		fmt.Print(banner)
		fmt.Println("用法: config_assistant")
		fmt.Println()
		fmt.Println("交互式终端程序，功能：")
		fmt.Println("  1. 查看当前环境的 GraphAgent 配置（按优先级展示各层来源与合并结果）")
		fmt.Println("  2. 从 models.dev 浏览模型并自动生成 provider 配置块")
		fmt.Println()
		fmt.Println("模型数据来源: https://models.dev/api.json （24h 本地缓存）")
		fmt.Println("配置 schema:   https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json （内嵌离线校验）")
		return
	}

	p := tea.NewProgram(tui.New(), tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "启动失败: %v\n", err)
		os.Exit(1)
	}
}
