# pi-prompt-suggestion

[English](README.md) | 中文

一个 [pi](https://pi.dev) 扩展：每轮对话结束后，预测你接下来最可能输入的消息，并以灰色提示文字（ghost text）显示在空输入框中。

- **Tab** 采纳建议，**Esc** 忽略建议。
- 开始打字时建议会隐藏，清空输入框后重新出现；发送消息或开始新一轮对话后建议作废。
- 输入框为空且没有显示建议时，按 **Tab** 立即生成一条。

从第二次助手回复之后开始生成建议，且输入框需空闲达到设定的延迟（默认 20 秒）。

## 特点

- **预测你会说的话，而不是助手想说的话。** 提示词和输出规则参照 Claude Code 的 prompt suggestion 功能：建议应是你自己会输入的下一句，而不是助手口吻的提议。
- **宁缺毋滥。** 模型输出会经过确定性过滤器，拒绝评价性语句（"看起来不错"、"谢谢"）、助手口吻、Markdown、代码、多句话和过长的内容。没有好的预测时，就什么都不显示。
- **复用会话的 prompt 缓存。** fork 模式发出的请求与主对话循环完全一致（相同的 thinking 级别、工具和参数），因此直接命中会话自己的缓存：长会话实测缓存命中率 99.9%，完整上下文的请求也几乎只产生缓存读取费用。一旦缓存变冷、过期或连续未命中，本会话内停用 fork，改用便宜的 segment 模式。
- **支持中文。** 中文对话给出中文建议；过滤器同样识别中日韩语言的客套话和助手口吻。
- **与其他编辑器扩展共存。** 扩展包装当前的输入框，而不是替换它，因此可与自带输入框的扩展（如 `pi-powerline-footer`）同时使用。实在无法画进输入框时，改为在输入框上方显示一行。
- **开箱即用。** 默认使用当前会话的模型，无需配置；所有设置都在 `/suggestion` 里修改，立即生效。
- **轻量。** 单个文件，除 pi 自身外没有任何依赖。

## 安装

扩展发布在 npm 上，使用 pi 的包管理器安装：

```bash
pi install npm:pi-prompt-suggestion
```

这会把它加入 `~/.pi/agent/settings.json` 的 `packages`，之后每个会话都会加载。重启 pi（或运行 `/reload`）即可生效。

```bash
pi install -l npm:pi-prompt-suggestion  # 仅对当前项目安装（.pi/settings.json）
pi -e npm:pi-prompt-suggestion          # 不安装，仅在本次会话中试用
pi update npm:pi-prompt-suggestion      # 更新到最新版本
pi remove npm:pi-prompt-suggestion      # 卸载
```

## 使用

照常工作即可。一轮对话结束、输入框保持空闲达到延迟时间后，预测的消息会以灰色文字出现：

| 按键 | 作用 |
|---|---|
| Tab | 采纳：把文字填入输入框（按 Enter 发送，或先修改） |
| Tab（输入框为空且无建议） | 立即生成一条建议 |
| Esc | 忽略 |
| 其他按键 | 正常输入；清空输入框后建议会重新出现 |

## 生成方式

- **segment**（默认）：只发送最后一轮的简短摘录，便宜、快速。
- **fork**：重放整个会话，使请求复用会话自身的 prompt 缓存；缓存命中时质量最好且成本很低。配置了其他模型时跳过 fork、使用 segment。一旦缓存看起来已冷或已过期，或 fork 连续未命中缓存，本会话内停用 fork；新会话或 `/reload` 后重新启用。

## 设置

运行 `/suggestion` 打开设置界面。设置保存在 `~/.pi/agent/prompt-suggestion.json`（或 `PI_CODING_AGENT_DIR` 指定的目录）中，修改后立即生效。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| Enabled | on | 关闭后不生成建议、不发送任何请求 |
| Tab to generate | on | 在空输入框中按 Tab 立即生成 |
| Context mode | segment | `fork` 或 `segment`（使用自定义模型时总是 segment） |
| Model | Follow session | 使用另一个（例如更便宜的）模型生成建议 |
| Idle delay | 20s | 一轮结束后输入框需空闲多久才生成 |
| Max length | 30 chars | 超过此长度的建议会被丢弃 |
| Cache freshness | 300s | 上次回复早于此时间则视为缓存已过期（本会话停用 fork） |
| Fork context limit | unlimited | 会话超过此 token 数时跳过 fork |
| Diagnostic log | off | 每次生成写一行 JSONL 到 `~/.pi/agent/prompt-suggestion.log` |

设置环境变量 `PI_SUGGESTION_LOG=<路径>` 也可启用诊断日志。

## 成本

每条建议是一次额外的模型请求。segment 模式下请求很小；fork 模式下是完整上下文的请求，缓存命中时大部分是缓存读取。如需关闭：`/suggestion` → Enabled → off。

## 许可证

MIT
