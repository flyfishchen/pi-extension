# pi-prompt-suggestion

[English](README.md) | 中文

一个 [pi](https://pi.dev) 扩展：预测你接下来最可能输入的消息，并以灰色提示文字（ghost text）显示在空输入框中。

- 在空输入框中按 **Tab** 生成建议；再按 **Tab** 采纳，按 **Esc** 忽略。
- 开始打字时建议会隐藏，清空输入框后重新出现；发送消息或开始新一轮对话后建议作废。
- 可选：设置 **Idle delay** 后，一轮对话结束、输入框空闲达到该时长时自动生成建议（默认关闭）。

## 特点

- **预测你会说的话，而不是助手想说的话。** 提示词和输出规则参照 Claude Code 的 prompt suggestion 功能：建议应是你自己会输入的下一句，而不是助手口吻的提议。
- **宁缺毋滥。** 模型输出会经过确定性过滤器，拒绝评价性语句（"看起来不错"、"谢谢"）、助手口吻、Markdown、代码、多句话和过长的内容。没有好的预测时，就什么都不显示。
- **复用会话的 prompt 缓存。** fork 模式发出的请求与主对话循环完全一致（相同的 thinking 级别、工具和参数），因此直接命中会话自己的缓存：长会话实测缓存命中率 99.9%，完整上下文的请求也几乎只产生缓存读取费用。缓存变冷或过期期间改用便宜的 segment 模式（使用你配置的 segment 模型）；继续对话、缓存重新变热后自动恢复 fork。
- **支持中文。** 中文对话给出中文建议；过滤器同样识别中日韩语言的客套话和助手口吻。
- **与其他编辑器扩展共存。** 扩展包装当前的输入框，而不是替换它，因此可与自带输入框的扩展（如 `pi-powerline-footer`）同时使用。实在无法画进输入框时，改为在输入框上方显示一行。
- **开箱即用。** 默认使用 fork 模式和会话模型，无需配置；所有设置都在 `/suggestion` 里修改，立即生效。
- **轻量。** 单个文件，除 pi 自身外没有任何依赖。

## 安装

扩展发布在 npm 上，使用 pi 的包管理器安装：

```bash
pi install npm:pi-prompt-suggestion
```

这会把它加入 `~/.pi/agent/settings.json` 的 `packages`，之后每个会话都会加载。重启 pi（或运行 `/reload`）即可生效，无需配置。

```bash
pi install -l npm:pi-prompt-suggestion  # 仅对当前项目安装（.pi/settings.json）
pi -e npm:pi-prompt-suggestion          # 不安装，仅在本次会话中试用
pi update npm:pi-prompt-suggestion      # 更新到最新版本
pi remove npm:pi-prompt-suggestion      # 卸载
```

## 使用

助手回复后，在空输入框中按 Tab，预测的消息会以灰色文字出现。如果不想每次按 Tab，可以在 `/suggestion` 中设置 Idle delay（自动生成从第二次助手回复之后开始）。

| 按键 | 作用 |
|---|---|
| Tab（输入框为空且无建议） | 生成一条建议 |
| Tab（显示建议时） | 采纳：把文字填入输入框（按 Enter 发送，或先修改） |
| Esc | 忽略 |
| 其他按键 | 正常输入；清空输入框后建议会重新出现 |

## 生成方式

在 `/suggestion` → Context mode 中选择模式：

- **fork**（默认）：用**会话模型**重放整个会话，使请求复用会话自身的 prompt 缓存；缓存命中时质量最好且成本很低。模型没有返回可用结果时，回退到 segment（使用 segment 模型；未配置则不回退）。缓存看起来已冷或已过期时改用 segment；继续对话、新一轮让缓存重新变热后，自动恢复 fork。如果 fork 连续未命中缓存，本会话内停用 fork；新会话或 `/reload` 后重新启用。
- **segment**：把最后一轮的简短摘录发给 **segment 模型**，便宜、快速。需要在 Segment model 中选择模型；未选择时，segment 模式不生成任何建议。

如果希望缓存冷或过期时也有建议，请选择一个 **Segment model**（例如便宜、快速的模型）。未选择时 fork 没有回退，这些时候不显示建议。

## 设置

运行 `/suggestion` 打开设置界面。设置保存在 `~/.pi/agent/prompt-suggestion.json`（或 `PI_CODING_AGENT_DIR` 指定的目录）中，修改后立即生效。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Context mode | fork | `fork`（会话模型，复用 prompt 缓存）或 `segment`（segment 模型，简短摘录） |
| Segment model | Not set | segment 请求使用的模型，包括 fork 的回退。未设置则不发送 segment 请求。fork 总是使用会话模型 |
| Tab to generate | on | 在空输入框中按 Tab 立即生成 |
| Idle delay | off | 一轮结束后输入框空闲多久自动生成；`off`（0）：只在按 Tab 时生成 |
| Max length | 30 chars | 超过此长度的建议会被丢弃 |
| Cache freshness | 300s | 上次回复早于此时间则视为缓存已过期（改用 segment，直到下一轮让缓存变热） |
| Fork context limit | unlimited | 会话超过此 token 数时跳过 fork |
| Diagnostic log | off | 每次生成写一行 JSONL 到 `~/.pi/agent/prompt-suggestion.log` |

设置环境变量 `PI_SUGGESTION_LOG=<路径>` 也可启用诊断日志。

## 成本

每条建议是一次额外的模型请求。fork 模式（默认）下是完整上下文的请求，但只在缓存热时运行，大部分是缓存读取；segment 模式下请求很小。只有按 Tab 或设置了 Idle delay 时才会发送请求；同时关闭 Tab to generate 即停止所有请求。

## 许可证

MIT
