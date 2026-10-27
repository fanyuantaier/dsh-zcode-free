import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCredential, ZCODE_ORIGIN } from './lib/zcode-upstream.mjs';
import { fetchEntitledModels, fetchBalance, chatMessages, readFreshCaptchaParams, PATH_MESSAGES } from './lib/zcode-upstream.mjs';
import { openaiToAnthropic, anthropicToOpenai, anthropicSseToOpenai } from './lib/translate.mjs';

/**
 * dsh-zcode-free
 *
 * Local OpenAI-compatible bridge for ZCode's free "zcode-plan" quota.
 *
 *   http://127.0.0.1:11451/v1/models              GET  model catalog (upstream client configs)
 *   http://127.0.0.1:11451/v1/balance             GET  free quota buckets
 *   http://127.0.0.1:11451/v1/chat/completions    POST OpenAI wire in, Anthropic wire out
 *   http://127.0.0.1:11451/health                 GET  credential + upstream status
 */

const VERSION = '0.1.0';
const RETRY_AFTER_UNUSUAL_ACTIVITY = 1800;
const RETRY_AFTER_CONCURRENCY = 30;
const RETRY_AFTER_WAF_BLOCK = 86400;

const MODEL_META = {
  'glm-5.3-flash': { label: 'GLM-5.3-Flash (ZCode free)', contextWindow: 1048576, maxCompletionTokens: 131072, vision: true, free: true },
  'glm-5.3': { label: 'GLM-5.3 (ZCode free)', contextWindow: 1048576, maxCompletionTokens: 131072, vision: true, free: true },
  'glm-5-3-flash': { label: 'GLM-5.3-Flash (ZCode free)', contextWindow: 1048576, maxCompletionTokens: 131072, vision: true, free: true },
  'glm-5-3': { label: 'GLM-5.3 (ZCode free)', contextWindow: 1048576, maxCompletionTokens: 131072, vision: true, free: true },
};

function normalizeModelId(id) {
  return String(id || '').toLowerCase().replace(/_/g, '-');
}

function args() {
  const argv = process.argv.slice(2);
  const options = { port: 11451, host: '127.0.0.1', log: 'quiet' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--port' && value && /^\d+$/.test(value)) { options.port = Number(value); i++; }
    else if (argv[i] === '--host' && value) { options.host = value; i++; }
    else if (argv[i] === '--log' && value) { options.log = value; i++; }
  }
  return options;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { message, type: 'invalid_request_error', code, ...extra } }, extra.headers);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function credentialOf(env) {
  const credential = resolveCredential(env);
  if (!credential) {
    return { error: 'no_zcode_login', message: 'No ZCode login found. Log in to ZCode once, or set ZCODE_JWT.' };
  }
  if (credential.error) return { error: 'incomplete_zcode_credential', message: credential.error };
  return { credential };
}

function handleChatCompletions(res, request, credential, env) {
  const body = openaiToAnthropic(request, { defaultModel: 'glm-5.3-flash', maxTokens: 32768 });
  const stream = request.stream === true;

  if (!stream) {
    return chatMessages(credential, body, { captcha: readFreshCaptchaParams(env) }).then((result) => {
      if (!result.ok || result.error) {
        if (result.error === 'unusual_activity') {
          return sendError(res, 429, 'zcode_unusual_activity', unusualActivityMessage(result.text), { headers: { 'retry-after': String(RETRY_AFTER_UNUSUAL_ACTIVITY) } });
        }
        if (result.error === 'waf_blocked') {
          return sendError(res, 429, 'zcode_waf_blocked', wafBlockedMessage(result), { headers: { 'retry-after': String(RETRY_AFTER_WAF_BLOCK) } });
        }
        if (result.error === 'concurrency_limited') {
          return sendError(res, 429, 'zcode_concurrency_limited', concurrencyMessage(result.text), { headers: { 'retry-after': String(RETRY_AFTER_CONCURRENCY) } });
        }
        return sendError(res, 502, 'zcode_upstream_error', upstreamRejectionMessage(result));
      }
      return sendJson(res, 200, anthropicToOpenai(result.json, body.model, 'chatcmpl-' + randomUUID().slice(0, 12)));
    }).catch((error) => rejectNetworkError(res, error));
  }

  // Streaming path.
  const captcha = readFreshCaptchaParams(env);
  let settled = false;
  chatMessages(credential, { ...body, stream: true }, { captcha }).then((result) => {
    if (!result.ok || result.error) {
      if (result.error === 'unusual_activity') {
        settled = true;
        return sendError(res, 429, 'zcode_unusual_activity', unusualActivityMessage(result.text), { headers: { 'retry-after': String(RETRY_AFTER_UNUSUAL_ACTIVITY) } });
      }
      if (result.error === 'waf_blocked') {
        settled = true;
        return sendError(res, 429, 'zcode_waf_blocked', wafBlockedMessage(result), { headers: { 'retry-after': String(RETRY_AFTER_WAF_BLOCK) } });
      }
      if (result.error === 'concurrency_limited') {
        return sendError(res, 429, 'zcode_concurrency_limited', concurrencyMessage(result.text), { headers: { 'retry-after': String(RETRY_AFTER_CONCURRENCY) } });
      }
      settled = true;
      return sendError(res, 502, 'zcode_upstream_error', upstreamRejectionMessage(result));
    }
    if (res.writableEnded) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-bridge': 'dsh-zcode-free/' + VERSION,
    });
    const frames = result.stream();
    const chunks = anthropicSseToOpenai(frames, body.model);
    let timer;
    // chunks 是异步生成器（上游 SSE 是异步流），必须 for-await 泵送；
    // 旧同步 next() 第一拍就抛 TypeError 被吞，表现为 200+零字节空流。
    const pump = async () => {
      try {
        for await (const line of chunks) {
          if (res.writableEnded) return;
          if (typeof line === 'string' && line.startsWith('data: [DONE]')) {
            res.end(line);
            return;
          }
          res.write(line);
        }
        if (!res.writableEnded) res.end();
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (!res.writableEnded) res.end();
        log('chat stream failed: ' + (error && error.message));
      }
    };
    pump();
  }).catch((error) => { if (!settled && !res.writableEnded) rejectNetworkError(res, error); });
}

function unusualActivityMessage(text) {
  const body = typeof text === 'string' ? text : '';
  const logid = /"logid":"([^"]+)"/.exec(body);
  return [
    'ZCode blocked this request as unusual activity (code 3012) - the free endpoint requires an Aliyun captcha param right now.',
    'Nothing was billed and no retry loop was started (repeating it escalates the account cooldown to 30 min / 24 h).',
    'Pass a fresh param via ZCODE_CAPTCHA_PARAM="...' + (logid ? ', logid ' + logid[1] : '') + '".',
  ].join(' ');
}

/** Message for a WAF/CDN block page - the request never reached the app. */
function wafBlockedMessage(result) {
  const body = (result && result.text) || '';
  const logid = /"logid":"([^"]+)"/.exec(body);
  return [
    'ZCode edge blocked this request with a WAF block page (HTTP ' + result.status + ' + HTML) - the request never reached the ZCode application, so no app-level code was returned.',
    'Not fixable from the client: header, body and transport changes cannot clear it and retrying only deepens the block. Back off at least ' + Math.floor(RETRY_AFTER_WAF_BLOCK / 3600) + 'h; the ZCode desktop app on this account is likely blocked too.',
    'Nothing was billed, and the credential itself is still valid - the balance endpoint answers with this same token.',
  ].join(' ') + (logid ? ' logid ' + logid[1] : '');
}

/** Message for a transient 3009 concurrency verdict - retryable, nothing billed. */
function concurrencyMessage(text) {
  const body = (typeof text === 'string' ? text : '').trim();
  const logid = /"logid":"([^"]+)"/.exec(body);
  return [
    'ZCode reported a transient model concurrency limit (code 3009) - a request is already in flight, most likely from the ZCode desktop app, which runs with the same credential and holds the slot. This is not the 3012 captcha block.',
    'Safe to retry after a few seconds; nothing was billed.',
  ].join(' ') + (logid ? ' logid ' + logid[1] : '');
}

/** Human-readable message for an upstream rejection that is not a 3012 captcha verdict. */
function upstreamRejectionMessage(result) {
  const body = truncate((result && result.text) || '', 400).trim();
  const status = result && result.status ? 'HTTP ' + result.status : 'unknown status';
  const headers = result && result.headers ? result.headers : {};
  const wanted = ['x-request-id', 'x-trace-id', 'traceparent', 'x-log-id', 'eagleeye-traceid', 'x-dsr-service'];
  const keys = Object.keys(headers);
  const hits = [];
  for (const want of wanted) {
    const key = keys.find((name) => name.toLowerCase() === want);
    if (key && headers[key]) hits.push(key + '=' + headers[key]);
  }
  const trace = hits.length ? ' [' + hits.join(', ') + ']' : '';
  return 'ZCode upstream rejected the request (' + status + trace + '): ' +
    (body ? body : 'empty body - the request died at the edge gateway before the ZCode app layer, so there is no 3012 verdict and nothing was billed.');
}

function rejectNetworkError(res, error) {
  if (res.writableEnded) return;
  const status = error && error.status === 413 ? 413 : 502;
  const code = error && error.status === 413 ? 'body_too_large' : 'bridge_error';
  sendError(res, status, code, (error && error.message) || String(error));
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function log(message, options = {}) {
  if (options.log === 'quiet') return;
  console.log(new Date().toISOString() + ' ' + message);
}

function buildServer(options) {
  const { env } = options;

  const modelsCache = { at: 0, value: undefined, ttl: Number(env.ZCODE_MODEL_TTL_MS || 300000) };

  async function models() {
    if (modelsCache.value && Date.now() - modelsCache.at < modelsCache.ttl) return modelsCache.value;
    const { credential } = credentialOf(env);
    if (!credential) return { error: credentialOf(env).message };
    const result = await fetchEntitledModels(credential, env).catch(() => undefined);
    if (!result || !result.ok) {
      return [{ id: 'glm-5.3-flash', object: 'model', created: 0, owned_by: 'zcode', display_name: MODEL_META['glm-5.3-flash'].label }];
    }
    const seen = new Set();
    const out = [];
    for (const model of result.models) {
      const key = normalizeModelId(model.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: 'zcode',
        display_name: (MODEL_META[key] && MODEL_META[key].label) || model.displayName || model.name || model.id,
        context_window: model.contextWindow,
        max_completion_tokens: model.maxTokens,
        free_remaining_tokens: model.remainingTokens,
      });
    }
    if (out.length === 0) {
      out.push({ id: 'glm-5.3-flash', object: 'model', created: 0, owned_by: 'zcode', display_name: MODEL_META['glm-5.3-flash'].label });
    }
    modelsCache.at = Date.now();
    modelsCache.value = out;
    return out;
  }

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const method = req.method || 'GET';
    let finalStatus = null;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => {
      finalStatus = Number(status) || finalStatus;
      return originalWriteHead(status, ...rest);
    };
    res.on('close', () => {
      log(method + ' ' + pathname + ' -> ' + (finalStatus || res.statusCode || '?') + ' in ' + (Date.now() - started) + 'ms', options);
    });
    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
        const { credential, message } = credentialOf(env);
        return sendJson(res, credential ? 200 : 503, {
          ok: Boolean(credential),
          service: 'dsh-zcode-free',
          version: VERSION,
          upstream: ZCODE_ORIGIN,
          plan: 'zcode-plan',
          endpoint: PATH_MESSAGES,
          credential: credential ? {
            jwt_source: credential.jwt_source,
            device_source: credential.device_source,
            app_version: credential.app_version,
            user: credential.user ? { user_id: credential.user.user_id, name: credential.user.name } : undefined,
          } : { error: message },
        });
      }

      if (method === 'GET' && pathname === '/v1/models') {
        const modelsList = await models();
        if (modelsList && modelsList.error) return sendError(res, 503, 'no_zcode_login', modelsList.error);
        return sendJson(res, 200, { object: 'list', data: modelsList });
      }

      if (method === 'GET' && (pathname === '/v1/balance' || pathname === '/balance')) {
        const { credential } = credentialOf(env);
        if (!credential) return sendError(res, 503, 'no_zcode_login', credentialOf(env).message);
        const result = await fetchBalance(credential, env);
        if (!result.ok) {
          if (result.error === 'unusual_activity') return sendError(res, 429, 'zcode_unusual_activity', unusualActivityMessage(result.text));
          return sendError(res, 502, 'zcode_upstream_error', upstreamRejectionMessage(result));
        }
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === 'POST' && pathname === '/v1/chat/completions') {
        const { credential, message } = credentialOf(env);
        if (!credential) return sendError(res, 503, 'no_zcode_login', message);
        let chatRequest;
        try { chatRequest = await readBody(req); } catch (error) { return rejectNetworkError(res, error); }
        log('POST /v1/chat/completions model=' + chatRequest.model + ' stream=' + chatRequest.stream, options);
        return handleChatCompletions(res, chatRequest, credential, env);
      }

      return sendError(res, 404, 'not_found', 'Unknown route ' + method + ' ' + pathname + '. Try /v1/models, /v1/balance, /v1/chat/completions, /health.');
    } catch (error) {
      log('unhandled ' + method + ' ' + pathname + ': ' + (error && error.message));
      rejectNetworkError(res, error);
    }
  });
}

export { buildServer, args, MODEL_META };

const isMain = (() => {
  try {
    const invoked = fileURLToPath(path.resolve(process.argv[1] || ''));
    return invoked === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  const options = args();
  const server = buildServer({ ...options, env: process.env });
  server.listen(options.port, options.host, () => {
    console.log('dsh-zcode-free ' + VERSION + ' listening on http://' + options.host + ':' + options.port);
    console.log('  models   http://' + options.host + ':' + options.port + '/v1/models');
    console.log('  balance  http://' + options.host + ':' + options.port + '/v1/balance');
    console.log('  chat     POST http://' + options.host + ':' + options.port + '/v1/chat/completions');
    const { credential } = credentialOf(process.env);
    if (credential) console.log('  login    ' + credential.jwt_source + ' / ' + credential.device_source + ' / app ' + credential.app_version);
    else console.log('  login    ' + credentialOf(process.env).message);
  });
}
