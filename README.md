# 模型价格行情 · LLM API Price Index

主流旗舰大模型 API 价格对比看板。**人民币 / 百万 tokens**，每日自动更新，纯脚本实现，不依赖任何大模型 API。

## 数据来源

| 来源 | 覆盖范围 | 更新方式 |
| --- | --- | --- |
| [litellm 社区价格库](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) | OpenAI / Anthropic / Google 等美元计价厂商 | GitHub Actions 每日自动拉取 |
| [open.er-api.com](https://open.er-api.com) | USD → CNY 汇率 | 每日自动拉取 |
| `data/overrides.json` | DeepSeek 峰谷定价、智谱 / 月之暗面 / 阿里通义人民币原价、xAI | 手动核对维护（首次录入于 2026-08-14） |

## 本地使用

```bash
# 重新生成价格数据（需要网络）
node scripts/build-data.mjs

# 本地预览（fetch 加载 JSON，需 http 服务）
npx serve .
# 或
python3 -m http.server 8000
```

## 部署到 GitHub Pages

1. 把本目录推到 GitHub 仓库：
   ```bash
   git init && git add -A && git commit -m "init"
   gh repo create llm-api-prices --public --source=. --push
   ```
2. 仓库 **Settings → Pages → Build and deployment** 选择 **GitHub Actions**。
3. 手动触发一次 **Actions → 每日更新价格并部署**，之后每天 UTC 00:30（北京 08:30）自动更新并发布。

## 如何手动改价格

只改 `data/overrides.json`（人民币原价 / 峰谷价 / litellm 覆盖不到的模型），然后：

- 本地：运行 `node scripts/build-data.mjs` 并提交 `data/prices.json`；
- 线上：提交 overrides 后在 Actions 手动触发一次工作流即可。

litellm 侧的模型清单在 `scripts/build-data.mjs` 顶部的 `LITELLM_MODELS` 里维护（增删模型、调整候选 key）。
