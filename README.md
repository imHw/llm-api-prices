# 模型价格行情 · LLM API Price Index

> 🔗 **在线访问**：[https://imhw.github.io/llm-api-prices/](https://imhw.github.io/llm-api-prices/)

主流旗舰大模型 API 价格对比看板。**人民币 / 百万 tokens**，每日自动更新，纯脚本实现，不依赖任何大模型 API。

## 数据来源

| 来源 | 覆盖范围 | 更新方式 |
| --- | --- | --- |
| [litellm 社区价格库](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) | 全网海量模型实时官方计价（含 CDN 镜像容灾回退） | GitHub Actions 每日自动拉取 |
| [OpenRouter API](https://openrouter.ai/models) | 实时动态补充最新旗舰模型、多阶梯计费与中外新发布模型 | 自动化抓取融合 |
| [open.er-api.com](https://open.er-api.com) | USD → CNY 汇率 | 每日自动拉取（失败自动沿用历史汇率） |
| `data/overrides.json` | 厂商官方人民币原价、DeepSeek 峰谷时段特殊定价 | 手动维护（自动与抓取模型融合） |

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

构建脚本采用**智能自动抓取与动态模型发现机制**，厂商新发布的主流模型与计费阶梯无需手动维护即可自动捕获；若需指定特定模型或微调规则，可在 `scripts/build-data.mjs` 的 `VENDORS_CONFIG` 中配置。
