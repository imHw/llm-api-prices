#!/usr/bin/env node
/**
 * build-data.mjs — 智能自动抓取与升级机制，构建全网大模型价格数据。
 *
 * 数据来源：
 *   1. litellm 社区价格库（BerriAI/litellm，海量模型实时价格，官方渠道优先）
 *   2. OpenRouter 实时模型价格库（动态补全中外最新旗舰模型及计费阶梯）
 *   3. data/overrides.json 手动维护的厂商人民币原价 / 峰谷定价
 *   4. open.er-api.com 实时汇率接口（USD -> CNY）
 *
 * 核心升级机制：
 *   - 旗舰核心系列动态智能匹配与命名归一化
 *   - 动态全网新模型发现（自动捕获官方新发布模型，无需修改代码）
 *   - 自动识别上下文长度阶梯定价（如 <=200k / >200k 等）
 *   - 智能融合机制：手动原价/峰谷价格优先，自动抓取的新模型无缝补入
 *   - 多镜像与回退机制，确保 GitHub Actions 每日稳定自动化执行
 *
 * 产物：data/prices.json（所有价格统一为 人民币 / 百万 tokens）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_MIRROR_URL =
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const M = 1_000_000;

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const usd2cny = (usdPerM, fx) => (usdPerM == null ? null : round2(usdPerM * fx));

async function fetchWithFallback(urls, headers = {}) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'llm-api-prices-bot/2.0', ...headers },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`GET ${url} -> HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`All endpoints failed: ${urls.join(', ')}`);
}

/** 厂商定义与核心旗舰/主流模型匹配器 */
const VENDORS_CONFIG = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    region: 'cn',
    homepage: 'https://api-docs.deepseek.com/quick_start/pricing',
    prefixes: ['deepseek/', 'deepseek-'],
    matchers: [
      { name: 'DeepSeek V4 Pro', patterns: ['deepseek[-/]?(deepseek[-/])?v4-pro'] },
      { name: 'DeepSeek V4 Flash', patterns: ['deepseek[-/]?(deepseek[-/])?v4-flash'] },
      { name: 'DeepSeek V3.2', patterns: ['deepseek[-/]?(deepseek[-/])?v3\\.2', 'deepseek\\.v3\\.2'] },
      { name: 'DeepSeek V3', patterns: ['deepseek[-/]deepseek-v3$', '^deepseek-chat$', '^deepseek/deepseek-chat$'] },
      { name: 'DeepSeek R1', patterns: ['deepseek[-/]deepseek-r1$', '^deepseek-reasoner$', '^deepseek/deepseek-reasoner$'] },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱',
    region: 'cn',
    homepage: 'https://docs.bigmodel.cn/cn/guide/models',
    prefixes: ['zai/', 'z-ai/'],
    matchers: [
      { name: 'GLM-5.3', patterns: ['^(zai[-/]|z-ai/)?glm-5\\.3$', '^(zai[-/]|z-ai/)?glm-5-3$'] },
      { name: 'GLM-5.3 Flash', patterns: ['glm-5\\.3-flash', 'glm-5-3-flash'] },
      { name: 'GLM-5.2', patterns: ['^(zai[-/]|z-ai/)?glm-5\\.2$', '^(zai[-/]|z-ai/)?glm-5-2$'] },
      { name: 'GLM-5 Turbo', patterns: ['glm-5-turbo'] },
      { name: 'GLM-4.7 Flash', patterns: ['glm-4\\.7-flash'] },
    ],
  },
  {
    id: 'moonshot',
    name: '月之暗面',
    region: 'cn',
    homepage: 'https://platform.moonshot.cn/docs/pricing/chat',
    prefixes: ['moonshotai/', 'moonshot/'],
    matchers: [
      { name: 'Kimi K3', patterns: ['kimi-k3$'] },
      { name: 'Kimi K2.7 Code', patterns: ['kimi-k2\\.7-code'] },
      { name: 'Kimi K2.6', patterns: ['kimi-k2\\.6'] },
      { name: 'Kimi K2.5', patterns: ['kimi-k2\\.5'] },
    ],
  },
  {
    id: 'alibaba',
    name: '阿里通义',
    region: 'cn',
    homepage: 'https://help.aliyun.com/zh/model-studio/models',
    prefixes: ['dashscope/qwen', 'qwen/'],
    matchers: [
      { name: 'Qwen 3.8 Max', patterns: ['qwen3\\.8-max', 'dashscope/qwen3\\.8-max'] },
      { name: 'Qwen 3.8 Flash', patterns: ['qwen3\\.8-flash', 'qwen/qwen3\\.8-flash'] },
      { name: 'Qwen 3.7 Plus', patterns: ['qwen3\\.7-plus', 'dashscope/qwen3\\.7-plus'] },
      { name: 'Qwen 3.7 Flash', patterns: ['qwen3\\.7-flash', 'qwen/qwen3\\.7-flash'] },
      { name: 'Qwen 3 Coder', patterns: ['qwen3-coder-plus', 'dashscope/qwen-coder'] },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    region: 'cn',
    homepage: 'https://platform.minimaxi.com/docs/guides/pricing',
    prefixes: ['minimax/'],
    matchers: [
      { name: 'MiniMax M3', patterns: ['minimax-m3', 'MiniMax-M3'] },
      { name: 'MiniMax M2.7', patterns: ['minimax-m2\\.7', 'MiniMax-M2\\.7'] },
      { name: 'MiniMax M2.5', patterns: ['minimax-m2\\.5', 'MiniMax-M2\\.5'] },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    region: 'us',
    homepage: 'https://docs.x.ai/docs/models',
    prefixes: ['xai/', 'x-ai/'],
    matchers: [
      { name: 'Grok 4.6', patterns: ['grok-4\\.6'] },
      { name: 'Grok 4.5', patterns: ['grok-4\\.5'] },
      { name: 'Grok 4.3', patterns: ['grok-4\\.3'] },
      { name: 'Grok 4.1 Fast', patterns: ['grok-4-1-fast', 'grok-4\\.1-fast'] },
      { name: 'Grok 3 Mini', patterns: ['grok-3-mini'] },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    region: 'us',
    homepage: 'https://platform.openai.com/docs/pricing',
    prefixes: ['openai/', 'gpt-', 'o1', 'o3', 'o4'],
    matchers: [
      { name: 'GPT-6 Astra', patterns: ['gpt-6-astra$'] },
      { name: 'GPT-5.6 Sol', patterns: ['gpt-5\\.6-sol'] },
      { name: 'GPT-5.6 Luna', patterns: ['gpt-5\\.6-luna'] },
      { name: 'GPT-5.5', patterns: ['^gpt-5\\.5$', 'openai/gpt-5\\.5$'] },
      { name: 'GPT-5.4 Mini', patterns: ['gpt-5\\.4-mini'] },
      { name: 'o3', patterns: ['^o3$', 'openai/o3$'] },
      { name: 'o4-mini', patterns: ['^o4-mini', 'openai/o4-mini'] },
      { name: 'GPT-4o', patterns: ['^gpt-4o$', 'openai/gpt-4o$'] },
      { name: 'GPT-4o Mini', patterns: ['^gpt-4o-mini$', 'openai/gpt-4o-mini$'] },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    region: 'us',
    homepage: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
    prefixes: ['anthropic/', 'claude-'],
    matchers: [
      { name: 'Claude Mythos 5', patterns: ['claude-mythos-5'] },
      { name: 'Claude Fable 5.1', patterns: ['claude-fable-5[-.]1', 'claude-fable-5'] },
      { name: 'Claude Opus 5', patterns: ['claude-opus-5', 'claude-opus-4[-.]7'] },
      { name: 'Claude Sonnet 5', patterns: ['claude-sonnet-5', 'claude-sonnet-4[-.]6'] },
      { name: 'Claude 3.7 Sonnet', patterns: ['claude-3[-.]7-sonnet'] },
      { name: 'Claude Haiku 4.5', patterns: ['claude-haiku-4[-.]5', 'claude-3[-.]5-haiku'] },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    region: 'us',
    homepage: 'https://ai.google.dev/gemini-api/docs/pricing',
    prefixes: ['google/', 'gemini-'],
    matchers: [
      { name: 'Gemini 3.8 Flash', patterns: ['gemini-3\\.8-flash'] },
      { name: 'Gemini 3.1 Pro', patterns: ['gemini-3\\.1-pro', 'gemini-3-pro'] },
      { name: 'Gemini 3.1 Flash-Lite', patterns: ['gemini-3\\.1-flash-lite'] },
      { name: 'Gemini 2.5 Pro', patterns: ['gemini-2\\.5-pro'] },
      { name: 'Gemini 2.5 Flash', patterns: ['gemini-2\\.5-flash$', 'gemini-2\\.5-flash-001'] },
    ],
  },
];

/** 优先选取官方直接定价，避免渠道商代理溢价 */
function scoreLiteLLMKey(key, vendorId) {
  const k = key.toLowerCase();
  if (vendorId === 'openai') {
    if (k.startsWith('openai/') || (!k.includes('/') && (k.startsWith('gpt-') || k.startsWith('o1') || k.startsWith('o3') || k.startsWith('o4')))) return 100;
  }
  if (vendorId === 'anthropic') {
    if (k.startsWith('anthropic/') || (!k.includes('/') && k.startsWith('claude-'))) return 100;
  }
  if (vendorId === 'google') {
    if (k.startsWith('google/') || k.startsWith('gemini-')) return 100;
    if (k.startsWith('vertex_ai/gemini-')) return 80;
  }
  if (vendorId === 'deepseek') {
    if (k.startsWith('deepseek/') || k.startsWith('deepseek-')) return 100;
  }
  if (vendorId === 'xai') {
    if (k.startsWith('xai/') || k.startsWith('x-ai/')) return 100;
  }
  if (vendorId === 'alibaba') {
    if (k.startsWith('dashscope/')) return 100;
    if (k.startsWith('qwen/')) return 90;
  }
  if (vendorId === 'zhipu') {
    if (k.startsWith('zai/') || k.startsWith('z-ai/')) return 100;
  }
  if (vendorId === 'moonshot') {
    if (k.startsWith('moonshotai/') || k.startsWith('moonshot/')) return 100;
  }
  if (vendorId === 'minimax') {
    if (k.startsWith('minimax/')) return 100;
  }

  if (k.includes('azure') || k.includes('together') || k.includes('friendli') || k.includes('cloudflare') || k.includes('deepinfra')) {
    return 20;
  }
  return 50;
}

/** 格式化任意新模型名称为规范标题展示 */
function formatModelName(rawKey, vendorId) {
  let clean = rawKey
    .replace(/^([a-z0-9_.-]+)\//i, '')
    .replace(/^~/, '')
    .replace(/:.*$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(preview|latest|chat-latest)$/i, '');

  if (vendorId === 'deepseek') {
    if (clean === 'deepseek-chat') return 'DeepSeek V3';
    if (clean === 'deepseek-reasoner' || clean === 'deepseek-r1') return 'DeepSeek R1';
  }

  clean = clean.replace(/(\d+)-(\d+)/g, '$1.$2');

  const tokens = clean.split(/[-_]/).map((t) => {
    const low = t.toLowerCase();
    if (low === 'gpt') return 'GPT';
    if (low === 'glm') return 'GLM';
    if (low === 'claude') return 'Claude';
    if (low === 'gemini') return 'Gemini';
    if (low === 'deepseek') return 'DeepSeek';
    if (low === 'qwen') return 'Qwen';
    if (low === 'kimi') return 'Kimi';
    if (low === 'grok') return 'Grok';
    if (low === 'minimax') return 'MiniMax';
    if (low === 'pro') return 'Pro';
    if (low === 'flash') return 'Flash';
    if (low === 'lite') return 'Lite';
    if (low === 'mini') return 'Mini';
    if (low === 'nano') return 'Nano';
    if (low === 'max') return 'Max';
    if (low === 'plus') return 'Plus';
    if (low === 'turbo') return 'Turbo';
    if (low === 'coder') return 'Coder';
    if (low === 'code') return 'Code';
    if (low === 'sol') return 'Sol';
    if (low === 'luna') return 'Luna';
    if (low === 'terra') return 'Terra';
    if (low === 'astra') return 'Astra';
    if (low === 'opus') return 'Opus';
    if (low === 'sonnet') return 'Sonnet';
    if (low === 'haiku') return 'Haiku';
    if (low === 'fable') return 'Fable';
    if (low === 'mythos') return 'Mythos';
    if (/^v\d+(\.\d+)?$/i.test(low)) return low.toUpperCase();
    if (/^m\d+(\.\d+)?$/i.test(low)) return 'M' + low.slice(1);
    if (/^k\d+(\.\d+)?$/i.test(low)) return 'K' + low.slice(1);
    if (/^o\d+/i.test(low)) return low;
    if (/^qwen\d+/i.test(low)) return 'Qwen ' + low.slice(4);
    if (/^\d+(\.\d+)*$/.test(t)) return t;
    return t.charAt(0).toUpperCase() + t.slice(1);
  });

  return tokens
    .join(' ')
    .replace(/Flash Lite/i, 'Flash-Lite')
    .replace(/DeepSeek DeepSeek/i, 'DeepSeek')
    .replace(/MiniMax MiniMax/i, 'MiniMax')
    .replace(/^GPT\s+(\d)/, 'GPT-$1')
    .replace(/^GLM\s+(\d)/, 'GLM-$1');
}

/** 智能解析与提取模型价格（自动识别上下文阶梯输入定价） */
function extractModelRows(matcher, vendorId, litellmDb, orList, fxRate) {
  const regexes = matcher.patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
  let bestLitellmHit = null;
  let bestScore = -1;

  for (const pat of regexes) {
    for (const [k, v] of Object.entries(litellmDb)) {
      if (!v || typeof v.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') continue;
      if (k.includes(':batch') || k.includes('preview-0') || v.input_cost_per_token <= 0) continue;
      if (pat.test(k)) {
        const score = scoreLiteLLMKey(k, vendorId);
        if (score > bestScore) {
          bestScore = score;
          bestLitellmHit = { key: k, entry: v };
        }
      }
    }
  }

  let orHit = null;
  if (!bestLitellmHit) {
    for (const pat of regexes) {
      for (const m of orList) {
        if (!m.id.includes(':batch') && pat.test(m.id)) {
          const p = m.pricing;
          if (p && p.prompt && p.completion && parseFloat(p.prompt) > 0) {
            orHit = m;
            break;
          }
        }
      }
      if (orHit) break;
    }
  }

  if (!bestLitellmHit && !orHit) return [];

  const rows = [];
  if (bestLitellmHit) {
    const { key, entry } = bestLitellmHit;
    const baseIn = entry.input_cost_per_token * M;
    const baseOut = entry.output_cost_per_token * M;
    const baseCache =
      typeof entry.cache_read_input_token_cost === 'number'
        ? entry.cache_read_input_token_cost * M
        : typeof entry.input_cost_per_token_cache_hit === 'number'
        ? entry.input_cost_per_token_cache_hit * M
        : null;

    // 动态检测阶梯计费（如 _above_200k_tokens, _above_272k_tokens 等）
    const tierMatch = Object.keys(entry).find(
      (k) => k.startsWith('input_cost_per_token_above_') && k.endsWith('_tokens')
    );

    if (tierMatch) {
      const m = tierMatch.match(/^input_cost_per_token_above_(.+)_tokens$/);
      const tierLabel = m ? m[1] : 'tiered';
      const tierIn = entry[tierMatch] * M;
      const tierOut =
        (entry[`output_cost_per_token_above_${tierLabel}_tokens`] ?? entry.output_cost_per_token) * M;
      const tierCache =
        (entry[`cache_read_input_token_cost_above_${tierLabel}_tokens`] ??
          entry[`input_cost_per_token_cache_hit_above_${tierLabel}_tokens`] ??
          entry.cache_read_input_token_cost ??
          entry.input_cost_per_token_cache_hit) * M || null;

      rows.push({
        name: `${matcher.name} · ≤${tierLabel} 输入`,
        cachedInput: usd2cny(baseCache, fxRate),
        input: usd2cny(baseIn, fxRate),
        output: usd2cny(baseOut, fxRate),
        kind: 'usd',
        sourceKey: key,
      });
      rows.push({
        name: `${matcher.name} · >${tierLabel} 输入`,
        cachedInput: usd2cny(tierCache, fxRate),
        input: usd2cny(tierIn, fxRate),
        output: usd2cny(tierOut, fxRate),
        kind: 'usd',
        sourceKey: key,
      });
    } else {
      rows.push({
        name: matcher.name,
        cachedInput: usd2cny(baseCache, fxRate),
        input: usd2cny(baseIn, fxRate),
        output: usd2cny(baseOut, fxRate),
        kind: 'usd',
        sourceKey: key,
      });
    }
  } else if (orHit) {
    const p = orHit.pricing;
    const baseIn = parseFloat(p.prompt) * M;
    const baseOut = parseFloat(p.completion) * M;
    const baseCache = p.input_cache_read != null ? parseFloat(p.input_cache_read) * M : null;

    if (Array.isArray(p.overrides) && p.overrides.length > 0 && p.overrides[0].min_prompt_tokens) {
      const ov = p.overrides[0];
      const minTokens = ov.min_prompt_tokens;
      const tierLabel = minTokens >= 1000 ? `${Math.round(minTokens / 1000)}k` : `${minTokens}`;
      const ovIn = parseFloat(ov.prompt) * M;
      const ovOut = parseFloat(ov.completion) * M;
      const ovCache = ov.input_cache_read != null ? parseFloat(ov.input_cache_read) * M : null;

      rows.push({
        name: `${matcher.name} · ≤${tierLabel} 输入`,
        cachedInput: usd2cny(baseCache, fxRate),
        input: usd2cny(baseIn, fxRate),
        output: usd2cny(baseOut, fxRate),
        kind: 'usd',
        sourceKey: orHit.id,
      });
      rows.push({
        name: `${matcher.name} · >${tierLabel} 输入`,
        cachedInput: usd2cny(ovCache, fxRate),
        input: usd2cny(ovIn, fxRate),
        output: usd2cny(ovOut, fxRate),
        kind: 'usd',
        sourceKey: orHit.id,
      });
    } else {
      rows.push({
        name: matcher.name,
        cachedInput: usd2cny(baseCache, fxRate),
        input: usd2cny(baseIn, fxRate),
        output: usd2cny(baseOut, fxRate),
        kind: 'usd',
        sourceKey: orHit.id,
      });
    }
  }

  return rows;
}

async function main() {
  const warnings = [];
  console.log('· 拉取多源模型价格库…');

  const [litellm, openrouterData, fxData] = await Promise.all([
    fetchWithFallback([LITELLM_URL, LITELLM_MIRROR_URL]).catch((e) => {
      warnings.push(`litellm 价格库拉取失败: ${e.message}`);
      return {};
    }),
    fetchWithFallback([OPENROUTER_URL]).catch((e) => {
      warnings.push(`OpenRouter 价格库拉取失败: ${e.message}`);
      return { data: [] };
    }),
    fetchWithFallback([FX_URL]).catch((e) => {
      warnings.push(`汇率拉取失败，将尝试沿用旧值: ${e.message}`);
      return null;
    }),
  ]);

  let fx = null;
  if (fxData && fxData.rates && fxData.rates.CNY) {
    fx = { rate: fxData.rates.CNY, updatedAt: fxData.time_last_update_utc };
  } else {
    try {
      const prev = JSON.parse(readFileSync(join(ROOT, 'data/prices.json'), 'utf8'));
      fx = prev.fx;
      warnings.push(`已沿用历史汇率 USD->CNY = ${fx.rate}`);
    } catch {
      fx = { rate: 6.7255, updatedAt: new Date().toUTCString() };
    }
  }
  console.log(`  USD -> CNY = ${fx.rate}`);

  const orModels = openrouterData?.data || [];
  console.log(`  已载入 LiteLLM (${Object.keys(litellm).length} 条) + OpenRouter (${orModels.length} 条)`);

  // 1. 自动抓取并识别各厂商核心旗舰与主流模型
  const autoVendors = new Map();
  for (const vc of VENDORS_CONFIG) {
    const models = [];
    const matchedSourceKeys = new Set();

    for (const matcher of vc.matchers) {
      const rows = extractModelRows(matcher, vc.id, litellm, orModels, fx.rate);
      if (rows.length) {
        models.push(...rows);
        rows.forEach((r) => matchedSourceKeys.add(r.sourceKey));
        console.log(`  ✓ [${vc.name}] ${matcher.name} <- ${rows[0].sourceKey}`);
      } else {
        warnings.push(`[${vc.name}] 未能获取模型价格: ${matcher.name}`);
      }
    }

    // 2. 智能全网新模型发现机制：
    //    自动扫描该厂商前缀下是否存在 LiteLLM / OpenRouter 新发布的 chat/reasoning 模型
    const isIgnored = (rawKey) => {
      const kl = rawKey.toLowerCase();
      if (kl.includes('transcribe') || kl.includes('diarize') || kl.includes('realtime') || kl.includes('robotics')) return true;
      if (kl.includes('customtools') || kl.includes('live-preview') || kl.includes('audio') || kl.includes('video')) return true;
      if (kl.includes('search-preview') || kl.includes('search-api') || kl.includes('vision-preview')) return true;
      if (kl.includes('embedding') || kl.includes('reranker') || kl.includes('moderation')) return true;
      if (kl.includes(':free') || kl.includes(':batch') || kl.includes('image') || kl.includes('tts')) return true;
      if (kl.startsWith('gpt-3') || kl.includes('gpt-3.5')) return true;
      if (/^gpt-4-(0\d|11)/.test(kl)) return true;
      if (/-\d{8}/.test(kl) || /:0$/.test(kl)) return true;
      return false;
    };

    const capturedNames = new Set(models.map((m) => m.name.split(' · ')[0].trim().toLowerCase()));
    for (const [k, v] of Object.entries(litellm)) {
      if (!v || typeof v.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') continue;
      if (isIgnored(k)) continue;
      if (v.deprecation_date && new Date(v.deprecation_date) < new Date()) continue;

      const matchesPrefix = vc.prefixes.some((p) => k.toLowerCase().startsWith(p));
      if (matchesPrefix && scoreLiteLLMKey(k, vc.id) >= 80) {
        const candidateName = formatModelName(k, vc.id);
        const norm = candidateName.toLowerCase();
        if (!capturedNames.has(norm)) {
          const autoMatcher = { name: candidateName, patterns: [`^${k}$`] };
          const newRows = extractModelRows(autoMatcher, vc.id, litellm, orModels, fx.rate);
          if (newRows.length) {
            models.push(...newRows);
            capturedNames.add(norm);
            console.log(`  ✦ [${vc.name}] 自动发现新模型: ${candidateName} <- ${k}`);
          }
        }
      }
    }

    autoVendors.set(vc.id, {
      id: vc.id,
      name: vc.name,
      region: vc.region,
      homepage: vc.homepage,
      models,
    });
  }

  // 3. 读取手动 overrides 规则（国内厂商原价 / 峰谷特殊定价）
  const overridesPath = join(ROOT, 'data/overrides.json');
  let overrides = { vendors: [] };
  try {
    overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
  } catch (e) {
    warnings.push(`overrides.json 读取失败: ${e.message}`);
  }

  // 4. 智能融合机制：overrides 优先，未在 overrides 中的自动抓取模型自动补充进来！
  const finalVendorsMap = new Map();
  for (const [id, v] of autoVendors.entries()) {
    finalVendorsMap.set(id, { ...v, models: [...v.models] });
  }

  for (const ov of overrides.vendors || []) {
    const existing = finalVendorsMap.get(ov.id);
    const convertedOverrideModels = ov.models.map((m) => ({
      name: m.name,
      kind: m.kind,
      cachedInput: m.kind === 'usd' ? usd2cny(m.cachedInput, fx.rate) : m.cachedInput,
      input: m.kind === 'usd' ? usd2cny(m.input, fx.rate) : m.input,
      output: m.kind === 'usd' ? usd2cny(m.output, fx.rate) : m.output,
    }));

    if (!existing) {
      finalVendorsMap.set(ov.id, {
        id: ov.id,
        name: ov.name,
        region: ov.region,
        homepage: ov.homepage,
        models: convertedOverrideModels,
      });
    } else {
      const overrideRoots = new Set(
        convertedOverrideModels.map((m) => m.name.replace(/^(DeepSeek|Qwen|GLM|Kimi)\s+/i, '').split(' · ')[0].trim().toLowerCase())
      );
      const remainingAutoModels = existing.models.filter((m) => {
        const root = m.name.replace(/^(DeepSeek|Qwen|GLM|Kimi)\s+/i, '').split(' · ')[0].trim().toLowerCase();
        return !overrideRoots.has(root);
      });
      existing.models = [...convertedOverrideModels, ...remainingAutoModels];
    }
  }

  // 展示顺序：国内厂商在前（人民币原价 / 峰谷），海外在后
  const cnOrder = ['deepseek', 'zhipu', 'moonshot', 'alibaba', 'minimax'];
  const usOrder = ['xai', 'openai', 'anthropic', 'google'];
  const vendors = [...cnOrder, ...usOrder]
    .map((id) => finalVendorsMap.get(id))
    .filter(Boolean);

  for (const v of finalVendorsMap.values()) {
    if (!vendors.includes(v)) vendors.push(v);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    fx,
    unit: 'CNY / 1M tokens',
    sources: [
      { name: 'litellm 社区价格库', url: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json' },
      { name: 'OpenRouter 实时价格', url: 'https://openrouter.ai/models' },
      { name: 'open.er-api.com 汇率', url: 'https://open.er-api.com' },
      { name: '各厂商官方定价页', url: '' },
    ],
    warnings,
    vendors,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data/prices.json'), JSON.stringify(out, null, 2) + '\n');

  const totalEntries = vendors.reduce((s, v) => s + v.models.length, 0);
  console.log(`\n✔ data/prices.json 已成功构建：${vendors.length} 家厂商，${totalEntries} 个价格条目`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
}

main().catch((e) => {
  console.error(`✘ 构建失败：${e.message}`);
  process.exit(1);
});
