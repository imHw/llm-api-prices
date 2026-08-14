#!/usr/bin/env node
/**
 * build-data.mjs — 纯脚本构建价格数据，不依赖任何大模型 API。
 *
 * 数据来源：
 *   1. litellm 社区维护的价格库（BerriAI/litellm，每日更新，美元计价）
 *   2. data/overrides.json 手动维护的人民币原价 / 峰谷定价
 *   3. open.er-api.com 免费汇率接口（USD -> CNY）
 *
 * 产物：data/prices.json（所有价格统一为 人民币 / 百万 tokens）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const M = 1_000_000;

/** 从 litellm 拉取的海外厂商模型。keyCandidates 按优先级排列。 */
const LITELLM_MODELS = [
  {
    vendor: { id: 'openai', name: 'OpenAI', region: 'us', homepage: 'https://platform.openai.com/docs/pricing' },
    name: 'GPT-5.6 Sol',
    keyCandidates: ['gpt-5.6-sol'],
    tierAbove: '272k',
  },
  {
    vendor: { id: 'openai', name: 'OpenAI', region: 'us', homepage: 'https://platform.openai.com/docs/pricing' },
    name: 'GPT-5.6 Luna',
    keyCandidates: ['gpt-5.6-luna'],
    tierAbove: '272k',
  },
  {
    vendor: { id: 'anthropic', name: 'Anthropic', region: 'us', homepage: 'https://docs.anthropic.com/en/docs/about-claude/pricing' },
    name: 'Claude Fable 5',
    keyCandidates: ['claude-fable-5', 'anthropic.claude-fable-5'],
  },
  {
    vendor: { id: 'anthropic', name: 'Anthropic', region: 'us', homepage: 'https://docs.anthropic.com/en/docs/about-claude/pricing' },
    name: 'Claude Opus 5',
    keyCandidates: ['claude-opus-5', 'claude-opus-4-7', 'anthropic.claude-opus-4-7', 'claude-opus-4-6'],
  },
  {
    vendor: { id: 'google', name: 'Google', region: 'us', homepage: 'https://ai.google.dev/gemini-api/docs/pricing' },
    name: 'Gemini 3.1 Pro',
    keyCandidates: ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'],
    tierAbove: '200k',
  },
  {
    vendor: { id: 'google', name: 'Google', region: 'us', homepage: 'https://ai.google.dev/gemini-api/docs/pricing' },
    name: 'Gemini 3.1 Flash-Lite',
    keyCandidates: ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash-lite'],
  },
];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'llm-api-prices-bot' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

const round2 = (n) => Math.round(n * 100) / 100;
const usd2cny = (usdPerM, fx) => (usdPerM == null ? null : round2(usdPerM * fx));

function pickEntry(db, candidates) {
  for (const key of candidates) {
    const hit = Object.keys(db).find((k) => k === key);
    if (hit) return { key: hit, entry: db[hit] };
  }
  return null;
}

/** 把一条 litellm 记录转成展示行（可能拆出上下文阶梯两行）。 */
function toRows(spec, key, entry, fx, warnings) {
  const per = (field) => {
    const v = entry[field];
    return typeof v === 'number' ? v * M : null;
  };
  const base = {
    cachedInput: usd2cny(per('cache_read_input_token_cost'), fx),
    input: usd2cny(per('input_cost_per_token'), fx),
    output: usd2cny(per('output_cost_per_token'), fx),
  };
  if (base.input == null || base.output == null) {
    warnings.push(`${spec.name} (${key}) 缺少基础价格字段，已跳过`);
    return [];
  }
  const rows = [];
  const tier = spec.tierAbove;
  const tiered = tier && entry[`input_cost_per_token_above_${tier}_tokens`] != null;
  if (tiered) {
    rows.push({ ...base, name: `${spec.name} · ≤${tier} 输入` });
    rows.push({
      name: `${spec.name} · >${tier} 输入`,
      cachedInput: usd2cny(per(`cache_read_input_token_cost_above_${tier}_tokens`), fx) ?? base.cachedInput,
      input: usd2cny(per(`input_cost_per_token_above_${tier}_tokens`), fx),
      output: usd2cny(per(`output_cost_per_token_above_${tier}_tokens`), fx),
    });
  } else {
    rows.push({ ...base, name: spec.name });
  }
  return rows.map((r) => ({ ...r, kind: 'usd', sourceKey: key }));
}

async function main() {
  const warnings = [];
  console.log('· 拉取 litellm 价格库…');
  const litellm = await fetchJson(LITELLM_URL);

  console.log('· 拉取汇率…');
  let fx = null;
  try {
    const fxData = await fetchJson(FX_URL);
    fx = { rate: fxData.rates.CNY, updatedAt: fxData.time_last_update_utc };
  } catch (e) {
    warnings.push(`汇率拉取失败，沿用旧值：${e.message}`);
    const prev = JSON.parse(readFileSync(join(ROOT, 'data/prices.json'), 'utf8'));
    fx = prev.fx;
  }
  console.log(`  USD -> CNY = ${fx.rate}`);

  // 海外厂商：litellm 自动更新
  const autoVendors = new Map();
  for (const spec of LITELLM_MODELS) {
    const hit = pickEntry(litellm, spec.keyCandidates);
    if (!hit) {
      warnings.push(`${spec.name} 在 litellm 中未找到（候选：${spec.keyCandidates.join(', ')}）`);
      continue;
    }
    const rows = toRows(spec, hit.key, hit.entry, fx.rate, warnings);
    if (!rows.length) continue;
    if (!autoVendors.has(spec.vendor.id)) autoVendors.set(spec.vendor.id, { ...spec.vendor, models: [] });
    autoVendors.get(spec.vendor.id).models.push(...rows);
    console.log(`  ✓ ${spec.name} <- ${hit.key}`);
  }

  // 手动覆盖：国内厂商人民币原价 + litellm 覆盖不到的计价
  const overrides = JSON.parse(readFileSync(join(ROOT, 'data/overrides.json'), 'utf8'));
  const overrideVendors = overrides.vendors.map((v) => ({
    id: v.id,
    name: v.name,
    region: v.region,
    homepage: v.homepage,
    models: v.models.map((m) => ({
      name: m.name,
      kind: m.kind,
      cachedInput: m.kind === 'usd' ? usd2cny(m.cachedInput, fx.rate) : m.cachedInput,
      input: m.kind === 'usd' ? usd2cny(m.input, fx.rate) : m.input,
      output: m.kind === 'usd' ? usd2cny(m.output, fx.rate) : m.output,
    })),
  }));

  // 展示顺序：国内厂商在前（人民币原价），海外在后
  const cnOrder = ['deepseek', 'zhipu', 'moonshot', 'alibaba'];
  const usOrder = ['xai', 'openai', 'google', 'anthropic'];
  const byId = new Map([...overrideVendors, ...autoVendors.values()].map((v) => [v.id, v]));
  const vendors = [...cnOrder, ...usOrder].map((id) => byId.get(id)).filter(Boolean);
  for (const v of byId.values()) if (!vendors.includes(v)) vendors.push(v);

  const out = {
    updatedAt: new Date().toISOString(),
    fx,
    unit: 'CNY / 1M tokens',
    sources: [
      { name: 'litellm 社区价格库', url: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json' },
      { name: 'open.er-api.com 汇率', url: 'https://open.er-api.com' },
      { name: '各厂商官方定价页（手动核对）', url: '' },
    ],
    warnings,
    vendors,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data/prices.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✔ data/prices.json 已生成：${vendors.length} 家厂商，${vendors.reduce((s, v) => s + v.models.length, 0)} 个价格条目`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
}

main().catch((e) => {
  console.error(`✘ 构建失败：${e.message}`);
  process.exit(1);
});
