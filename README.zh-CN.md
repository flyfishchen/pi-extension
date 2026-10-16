# pi-extension

[English](README.md) | 中文

[pi coding agent](https://pi.dev) 的扩展集合。每个扩展都作为 pi 包发布到 npm，可以直接用 pi 安装。

| 扩展 | 说明 | npm |
|---|---|---|
| [prompt-suggestion](prompt-suggestion/README.zh-CN.md) | 每轮对话结束后预测你的下一条消息，以灰色提示文字显示在输入框中（Tab 采纳） | [`@flyfishchen/pi-prompt-suggestion`](https://www.npmjs.com/package/@flyfishchen/pi-prompt-suggestion) |

## 安装

使用 pi 的包管理器安装（从 npm 获取）：

```bash
pi install npm:@flyfishchen/pi-prompt-suggestion
```

这会把 `"npm:@flyfishchen/pi-prompt-suggestion"` 加入 `~/.pi/agent/settings.json` 的 `packages`，之后每个 pi 会话都会加载。重启 pi（或在运行中的会话里执行 `/reload`）即可生效。

其他方式：

```bash
pi install -l npm:@flyfishchen/pi-prompt-suggestion     # 仅对当前项目安装（.pi/settings.json）
pi install npm:@flyfishchen/pi-prompt-suggestion@0.1.0  # 固定版本
pi -e npm:@flyfishchen/pi-prompt-suggestion             # 不安装，仅在本次会话中试用
```

管理：

```bash
pi list                                          # 查看已安装的包
pi update --extensions                           # 更新到最新版本
pi remove npm:@flyfishchen/pi-prompt-suggestion  # 卸载
```

## 使用

第二次助手回复之后，输入框保持为空并空闲 20 秒，预测的下一条消息会以灰色文字出现在输入框中：

| 按键 | 作用 |
|---|---|
| Tab | 采纳建议（填入输入框，按 Enter 发送） |
| Tab（输入框为空且无建议） | 立即生成建议，无需等待 |
| Esc | 忽略建议 |
| 其他按键 | 正常输入；建议会隐藏，清空输入框后重新出现 |

运行 `/suggestion` 修改设置：开关、空闲延迟、最大长度、上下文模式（`segment` 便宜；`fork` 复用会话的 prompt 缓存，建议质量更好）或单独的模型。修改保存在 `~/.pi/agent/prompt-suggestion.json`，立即生效。全部设置项见[扩展说明](prompt-suggestion/README.zh-CN.md)。

每条建议是一次额外的模型请求。如需停止所有请求：`/suggestion` → Enabled → off。

## 开发

每个扩展位于独立文件夹，入口为 `index.ts`。pi 直接加载 TypeScript，无需构建。

如需使用本地代码而非 npm 包，先卸载 npm 包，再把文件夹加入 `~/.pi/agent/settings.json` 的 `extensions` 数组：

```json
{
  "extensions": ["~/project/pi-extension/prompt-suggestion"]
}
```

修改代码后在 pi 中运行 `/reload`。单独试用某个扩展：

```bash
pi -ne --no-mcp -e ./prompt-suggestion --no-session
```

发布新版本：修改扩展 `package.json` 中的 `version`，然后在该文件夹中运行 `npm publish`（包都在 `@flyfishchen` scope 下，以 public 权限发布）。

## 许可证

MIT
