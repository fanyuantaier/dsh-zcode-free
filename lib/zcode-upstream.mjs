import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverZcodeCredential, zcodeHome } from './zcode-auth.mjs';

/**
 * Thin client for ZCode's free plan upstream.
 *
 *   origin  https://zcode.z.ai
 *   plan    "zcode-plan" - the free daily / dev-day quota
 *   wire    Anthropic Messages compatible
 *
 * Endpoints (all verified reachable from this machine):
 *   GET  /api/v1/client/configs                        -> client config + builtin provider/model catalog
 *   GET  /api/v1/zcode-plan/billing/balance            -> free quota buckets
 *   POST /api/v1/zcode-plan/anthropic/v1/messages      -> chat completion (Anthropic wire)
 */

export const ZCODE_ORIGIN = 'https://zcode.z.ai';
export const PATH_MESSAGES = '/api/v1/zcode-plan/anthropic/v1/messages';
export const PATH_CONFIGS = '/api/v1/client/configs';
export const PATH_BALANCE = '/api/v1/zcode-plan/billing/balance';

/** HTTP 405 + code 3012 / "unusual activity" = Aliyun captcha gate. */
export const CODE_UNUSUAL_ACTIVITY = 3012;
export function isUnusualActivity(status, body) {
  const text = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  if (/unusual activity|blocked due to/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    return Number(parsed && parsed.code) === CODE_UNUSUAL_ACTIVITY;
  } catch { return false; }
}

/** HTTP 429 + code 3009 / "concurrency limit exceeded" = transient burst limit, not the captcha gate. */
export const CODE_CONCURRENCY_LIMIT = 3009;
export function isConcurrencyLimited(status, body) {
  const text = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  if (/concurrency limit exceeded/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    return Number(parsed && parsed.code) === CODE_CONCURRENCY_LIMIT;
  } catch { return false; }
}

/**
 * The upstream WAF/CDN serving a static block page instead of an app JSON
 * response. Observed 2026-10-25: HTTP 405 + a zh-cn HTML page carrying
 * Zhipu's data-spm marker. The request never reaches the ZCode application,
 * so no app-level code comes back and no retry can clear it.
 */
export function isWafBlock(status, body) {
  const text = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  if (!/<!doctype\s+html|<html[\s>]/i.test(text)) return false;
  return /<title>\s*4\d\d\s*<\/title>|data-spm/i.test(text);
}

/** App-level token rejection: HTTP 401 + code 4001 "token verify failed". */
export function isTokenVerifyFailed(status, body) {
  const text = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  if (/token verify failed/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text);
    return Number(parsed && parsed.code) === 4001;
  } catch { return false; }
}

/** Classify an upstream rejection. WAF first: an HTML page carries no app code. */
export function upstreamErrorKind(status, body) {
  if (isWafBlock(status, body)) return 'waf_blocked';
  if (isUnusualActivity(status, body)) return 'unusual_activity';
  if (isConcurrencyLimited(status, body)) return 'concurrency_limited';
  if (isTokenVerifyFailed(status, body)) return 'token_verify_failed';
  return 'http_' + status;
}

export function normalizeModelId(id) {
  return String(id || '').toLowerCase().replace(/_/g, '-');
}

export function buildHeaders(credential, extra = {}) {
  const appVersion = credential.app_version || '3.14.3';
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'ZCode/' + appVersion,
    'x-zcode-app-version': appVersion,
    'x-release-channel': 'stable',
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Asia/Shanghai',
    'x-device-mid': credential.device_mid || '',
    'x-platform': 'win32',
    'x-os-category': 'windows',
    'http-referer': ZCODE_ORIGIN + '/',
    'authorization': 'Bearer ' + credential.zcode_jwt,
  };
  return { ...headers, ...extra };
}

/**
 * 2026-10-24 晚定案：模型 POST 的 ESA 边缘闸（3012）按 HTTP 内容判分——
 * 必须携带桌面 agent 的完整请求形状：本文件同目录 plan-skeleton.json 的官方
 * system 三块 + 下述头族（复合 UA、双凭据头、x-zcode-* 一族、release-channel:
 * production）。TLS/cookie/captcha/session 注册全部无关（均已单发证伪/验证）。
 * 头与 body 配方由透明 MITM 抓包对比 + E1~E3 单发实验确定，详见
 * D:/workplace/dsh-zcode-free/EXPERIMENT-LOG-2026-10-24.md。
 */
function uuid7() {
  const ms = Date.now();
  const rand = crypto.randomUUID();
  return `${ms.toString(16).padStart(12, '0')}-7${rand.slice(15, 18)}-${rand.slice(19, 23)}-${rand.slice(24, 28)}-${rand.slice(29, 36)}`.slice(0, 36);
}

let skeletonCache;
export function planSkeleton() {
  if (!skeletonCache) {
    skeletonCache = JSON.parse(fs.readFileSync(new URL('./plan-skeleton.json', import.meta.url), 'utf8'));
  }
  return skeletonCache;
}

export function buildPlanHeaders(credential) {
  const appVersion = credential.app_version || '3.16.3';
  const ids = {
    sessionId: 'session_' + crypto.randomUUID().replaceAll('-', ''),
    requestId: crypto.randomUUID(),
    queryId: uuid7(),
    traceId: crypto.randomUUID(),
  };
  const headers = {
    'anthropic-beta': 'mid-conversation-system-2026-04-07',
    'anthropic-version': '2023-06-01',
    'authorization': 'Bearer ' + credential.zcode_jwt,
    'content-type': 'application/json',
    'http-referer': ZCODE_ORIGIN,
    'user-agent': `ZCode/${appVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/${process.versions.node.split('.')[0]}`,
    'x-api-key': credential.zcode_jwt,
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Asia/Shanghai',
    'x-device-mid': credential.device_mid || '',
    'x-os-category': 'windows',
    'x-os-version': '10.0.26200',
    'x-platform': 'win32-x64',
    'x-query-id': ids.queryId,
    'x-release-channel': 'production',
    'x-request-id': ids.requestId,
    'x-session-id': ids.sessionId,
    'x-title': 'Z Code@electron',
    'x-zcode-agent': 'glm',
    'x-zcode-app-version': appVersion,
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': ids.traceId,
  };
  return { headers, ids };
}

/** 注入官方骨架：system 前缀 + metadata + thinking/output_config 默认。
 *  ⚠ ESA 边缘闸要求 system 数组与官方三块一致——外来 system 内容拼进数组必 3012
 *  （10-24 实测：system 变体 429，temperature/tools/stream 均过）。因此调用方的
 *  system 一律改道注入为首条 user 消息，官方骨架原样保留。 */
export function wrapPlanBody(body, credential, ids) {
  const sk = planSkeleton();
  const callerSystemText = body.system
    ? (typeof body.system === 'string'
        ? body.system
        : body.system.map((b) => b.text || '').filter(Boolean).join('\n\n'))
    : '';
  let messages = body.messages;
  if (callerSystemText) {
    messages = [{ role: 'user', content: [{ type: 'text', text: callerSystemText }] }, ...messages];
  }
  const out = {
    model: body.model,
    max_tokens: body.max_tokens ?? 8192,
    metadata: {
      user_id: JSON.stringify({
        device_id: credential.device_mid || '',
        account_uuid: '',
        session_id: ids.sessionId,
      }),
    },
    system: [...sk.system],
    messages,
    stream: body.stream ?? false,
  };
  out.thinking = body.thinking ?? sk.thinking ?? undefined;
  if (out.thinking === undefined) delete out.thinking;
  if (sk.output_config) out.output_config = sk.output_config;
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;
  return out;
}

/**
 * Optional captcha param feed.
 *
 * The free endpoint is Aliyun-captcha gated when upstream decides the request
 * looks unusual. A param is only useful for ~20 seconds, so it is fed through
 * a file rather than baked into the request: one line, mtime must be fresh.
 *
 *   feed file content: <param>          (region defaults to cn)
 *                     <param>\t<region>
 *
 * Default path: ~/.zcode-bridge/captcha-param.txt  (override: ZCODE_CAPTCHA_FEED)
 */
export async function readFreshCaptchaParams(env = process.env) {
  if (env.ZCODE_CAPTCHA_PARAM && env.ZCODE_CAPTCHA_PARAM.trim().length > 0) {
    const [param, region] = env.ZCODE_CAPTCHA_PARAM.split('\t');
    return { param: param.trim(), region: (region || 'cn').trim() };
  }
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const file = env.ZCODE_CAPTCHA_FEED && env.ZCODE_CAPTCHA_FEED.trim().length > 0
    ? env.ZCODE_CAPTCHA_FEED
    : path.join(os.homedir(), '.zcode-bridge', 'captcha-param.txt');
  let raw;
  let mtime;
  try {
    const stat = fs.statSync(file);
    mtime = stat.mtimeMs;
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const ageMs = Date.now() - mtime;
  if (ageMs > Number(env.ZCODE_CAPTCHA_MAX_AGE_MS || 20000)) {
    return { param: raw.split(/\s+/)[0], region: (raw.split(/\s+/)[1] || 'cn').trim(), stale: true, ageMs };
  }
  const parts = raw.split(/\s+/);
  return { param: parts[0], region: (parts[1] || 'cn').trim(), ageMs };
}

async function requestJson(pathname, credential, init = {}, env = process.env) {
  const url = ZCODE_ORIGIN + pathname;
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: buildHeaders(credential),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return {
    ok: res.ok && (!json || json.code === undefined || json.code === 0),
    status: res.status,
    json,
    text,
    error: isUnusualActivity(res.status, text) ? 'unusual_activity' : res.ok ? undefined : 'http_' + res.status,
    env,
  };
}

/**
 * Free-plan models shipped with ZCode v3.14.x for the zcode-plan route.
 * Values mirror the ZCode client builtin catalog (zcode-builtin.json) and the
 * channel-pack fallback table.
 */
export const FREE_PLAN_MODELS = [
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', contextWindow: 1048576, maxTokens: 131072, vision: true, source: 'zcode-plan' },
  { id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 1048576, maxTokens: 128000, vision: true, source: 'zcode-plan' },
];

function findBuiltinCatalogFile(home) {
  const root = path.join(home, 'v2', 'runtime', 'provider');
  const candidates = [];
  try {
    for (const platform of fs.readdirSync(root)) {
      const platformDir = path.join(root, platform);
      let versions = [];
      try { versions = fs.readdirSync(platformDir); } catch { continue; }
      const ranked = versions
        .filter((version) => /^\d+\.\d+\.\d+/.test(version))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of ranked) {
        const base = path.join(platformDir, version);
        let endpoints = [];
        try { endpoints = fs.readdirSync(base); } catch { continue; }
        for (const endpoint of endpoints) {
          const file = path.join(base, endpoint, 'zcode-builtin.json');
          if (fs.existsSync(file)) candidates.push({ file, version });
        }
      }
    }
  } catch {
    return undefined;
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0] && candidates[0].file;
}

/** Model ids declared by the local ZCode builtin provider catalog, if present. */
export function builtinModelIdsFromDisk(env = process.env) {
  const file = findBuiltinCatalogFile(zcodeHome(env));
  if (!file) return { ids: [], file: undefined };
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = record.config || {};
    const templates = (config.providerConfigRules || {}).templateRules || [];
    const ids = new Set();
    for (const template of templates) {
      const api = (template.config || {}).api || {};
      const baseUrl = String(api.baseUrl || '');
      const templateId = String(template.templateId || '');
      if (templateId.startsWith('zai') || /z\.ai|zcode/.test(baseUrl)) {
        for (const id of template.config.builtinModelIds || []) ids.add(id);
      }
    }
    return { ids: [...ids], file };
  } catch {
    return { ids: [], file };
  }
}

/**
 * Model catalog. Prefers the live client-config endpoint; falls back to the
 * local ZCode builtin catalog and the static free-plan table, which is enough
 * to register the free models in DSH.
 */
export async function fetchModels(credential, env = process.env) {
  const disk = builtinModelIdsFromDisk(env);
  const known = new Map();
  for (const model of FREE_PLAN_MODELS) known.set(model.id, { ...model });
  for (const id of disk.ids) {
    if (!known.has(id)) known.set(id, { id, name: id, contextWindow: 1048576, maxTokens: 131072, source: 'builtin' });
  }

  let upstreamSource;
  try {
    const result = await requestJson(PATH_CONFIGS, credential, {}, env);
    if (result.json && result.json.code === 0) {
      const providers = (result.json.data && result.json.data.builtinProviders) || [];
      for (const provider of providers) {
        for (const id of provider.models || []) {
          if (known.has(id)) known.get(id).displayName = provider.name || known.get(id).name;
          else known.set(id, { id, name: provider.name || id, displayName: provider.name || id, source: 'client-configs' });
        }
      }
      upstreamSource = 'client-configs';
    } else {
      upstreamSource = 'client-configs:' + (result.error || 'http_' + result.status);
    }
  } catch {
    upstreamSource = 'client-configs:unreachable';
  }

  return {
    ok: true,
    models: [...known.values()],
    sources: { upstream: upstreamSource, disk: disk.file || 'not found' },
  };
}

/** Free quota buckets, as a small shape DSH can render. */
export async function fetchBalance(credential, env = process.env) {
  const result = await requestJson(PATH_BALANCE, credential, {}, env);
  if (!result.json || result.json.code !== 0) {
    return { ok: false, status: result.status, error: result.error, text: result.text };
  }
  const data = result.json.data || {};
  const plans = (data.plans || []).map((plan) => ({
    id: plan.plan_id,
    name: plan.name,
    status: plan.status,
    startsAt: plan.starts_at,
    endsAt: plan.ends_at,
  }));
  const buckets = (data.balances || data.buckets || []).map((bucket) => ({
    id: bucket.bucket_id,
    model: (bucket.capabilities || [])[0].replace(/^model:/, '') || bucket.model_id || bucket.entitlement,
    label: bucket.show_name || bucket.label || bucket.model_id,
    total: bucket.total_units ?? bucket.capacity ?? null,
    used: bucket.used_units ?? bucket.used ?? null,
    remaining: bucket.remaining_units ?? bucket.available_units ?? bucket.left ?? null,
    available: bucket.available_units ?? bucket.remaining_units ?? null,
    unitType: bucket.unit_type,
    meter: bucket.meter,
    planId: bucket.plan_id,
    periodStart: bucket.period_start,
    periodEnd: bucket.period_end,
    expiresAt: bucket.expires_at,
  }));
  return { ok: true, plans, buckets, serverTime: data.server_time, raw: data };
}

/**
 * Models this login is actually entitled to use for free, taken from the
 * balance entitlements (capabilities: ["model:glm-5.3-flash"]). This is the
 * honest answer to "which models are free on zcode-plan" - everything else in
 * the builtin catalog belongs to the paid zai templates.
 */
export async function fetchEntitledModels(credential, env = process.env) {
  const balance = await fetchBalance(credential, env);
  if (!balance.ok) return { ok: false, error: balance.error, status: balance.status, text: balance.text, models: [] };
  const meta = new Map();
  for (const model of FREE_PLAN_MODELS) meta.set(normalizeModelId(model.id), model);
  for (const id of builtinModelIdsFromDisk(env).ids) {
    const key = normalizeModelId(id);
    if (!meta.has(key)) meta.set(key, { id, name: id, contextWindow: 1048576, maxTokens: 131072, source: 'builtin' });
  }
  const seen = new Map();
  for (const bucket of balance.buckets) {
    const capability = (bucket.capabilities || [])[0];
    const rawId = capability ? capability.replace(/^model:/, '') : bucket.model;
    if (!rawId) continue;
    const key = normalizeModelId(rawId);
    const known = meta.get(key) || { id: rawId, name: rawId, contextWindow: 1048576, maxTokens: 131072, source: 'entitlement' };
    seen.set(key, {
      id: known.id,
      name: known.name,
      displayName: bucket.label || known.name,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
      vision: known.vision !== false,
      remainingTokens: bucket.remaining,
      totalTokens: bucket.total,
      usedTokens: bucket.used,
    });
  }
  return { ok: true, models: [...seen.values()], buckets: balance.buckets, plans: balance.plans, serverTime: balance.serverTime };
}


/** Chat completion. Non-streaming returns the Anthropic JSON body. */
export async function chatMessages(credential, body, opts = {}) {
  const captcha = opts.captcha ?? undefined;
  const { headers: planHeaders, ids } = buildPlanHeaders(credential);
  const wrapped = wrapPlanBody(body, credential, ids);
  const headers = { ...planHeaders, ...(opts.headers || {}) };
  if (captcha && captcha.param) {
    headers['x-aliyun-captcha-verify-param'] = captcha.param;
    headers['x-aliyun-captcha-verify-region'] = captcha.region || 'cn';
  }
  const res = await fetch(ZCODE_ORIGIN + PATH_MESSAGES, {
    method: 'POST',
    headers,
    body: JSON.stringify(wrapped),
    signal: opts.signal,
  });
  const responseHeaders = Object.fromEntries(res.headers.entries());

  if (!wrapped.stream) {
    const text = await res.text();
    const error = res.ok ? undefined : upstreamErrorKind(res.status, text);
    if (!res.ok) return { ok: false, status: res.status, text, error, headers: responseHeaders };
    try {
      const json = JSON.parse(text);
      if (json && json.type === 'error') {
        return { ok: false, status: res.status, text, error: json.error && json.error.type, json, headers: responseHeaders };
      }
      return { ok: true, status: res.status, json, text, headers: responseHeaders };
    } catch {
      return { ok: false, status: res.status, text, error: 'bad_upstream_json', headers: responseHeaders };
    }
  }

  // A rejected stream still carries a complete JSON error body (the 3012 captcha
  // verdict is not SSE), so read and classify it instead of treating the rejection
  // as a stream. Previously this returned { ok:false } with no error and no text,
  // which the bridge rendered as a 502 with an empty message.
  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      status: res.status,
      text,
      error: upstreamErrorKind(res.status, text),
      headers: responseHeaders,
    };
  }
  if (!res.body) {
    return { ok: false, status: res.status, text: '', error: 'empty_upstream_body', headers: responseHeaders };
  }
  return { ok: true, status: res.status, headers: responseHeaders, stream: () => sseEvents(res.body, new TextDecoder()) };
}

/** Minimal SSE frame parser over a web ReadableStream<Uint8Array>. */
export async function* sseEvents(body, decoder = new TextDecoder()) {
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let fence;
      while ((fence = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, fence);
        buffer = buffer.slice(fence + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { _raw: data }; }
        yield { event, data: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function resolveCredential(env = process.env) {
  return discoverZcodeCredential(env);
}
