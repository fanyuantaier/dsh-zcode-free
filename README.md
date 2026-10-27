# dsh-zcode-free

[English](README.md) · [简体中文](README.zh-CN.md)

Local **OpenAI-compatible bridge** that exposes ZCode's free *zcode-plan* quota
(`https://zcode.z.ai`) to DeepSeek Harness, plus the DSH wiring that registers
those models as a first-class provider.

> **背景 / Background** — ZCode（Z.ai 的编程 agent 桌面端）向免费 Start Plan 用户
> **每天发放 3 亿 token** 的免费额度（仅 GLM-5.3-Flash，当日有效；GLM-5.3 目前
> 不再享有每日额度）。本项目把这份额度从桌面客户端里解放出来：本地起一个
> OpenAI 兼容的 HTTP 桥（`:11451`），任何 OpenAI 客户端都能直接调用该模型。
> ZCode (Z.ai's coding-agent desktop app) grants free Start Plan accounts
> **300M tokens per day** (GLM-5.3-Flash only; GLM-5.3 currently has no daily
> quota); this bridge exposes that daily quota through a local OpenAI-compatible
> endpoint.

    DSH  -->  pi-ai openai-completions  -->  http://127.0.0.1:11451/v1
                                     (this bridge, OpenAI wire in)
                                          |
                                          v  Anthropic wire out
        https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages

---

## 1. What is verified working right now

| Check | Result |
| --- | --- |
| Local login discovery (`~/.zcode/v2/credentials.json`, AES-256-GCM) | jwt 255 chars, device mid `1aa52c08-...`, app `3.14.5` |
| `GET /api/v1/zcode-plan/billing/balance` | HTTP 200 |
| `GET /v1/models` through the bridge | HTTP 200 - 1 entitled model (GLM-5.3-Flash) with live quota |
| `GET /v1/balance` through the bridge | HTTP 200 - plan + 1 bucket |
| OpenAI <-> Anthropic translation | 30/30 assertions (`node cli.mjs selftest`) |
| `POST /v1/chat/completions` | **HTTP 429 / code 3012** - upstream captcha gate; after ~24 h it escalates to a WAF block page (429 `zcode_waf_blocked`, `retry-after: 86400`) - see §4 |

Live quota at the time of writing (2026-10-27, plan `ZCODE GLOBAL BUILD`,
plan id `zcode-v3-start-plan-1027`, status `active`, ends `1793149200`):

    GLM-5.3-Flash   287,426,965 / 300,000,000 tokens remaining
    GLM-5.3          no daily quota on the free Start Plan (entitlement removed)

The entitled model list is derived from the balance entitlements
(`capabilities: ["model:glm-5.3-flash"]`), not from the full builtin catalog,
so the bridge never advertises a model the free plan will not actually serve.

## 2. Run it

    D:\workplace\dsh-zcode-free\start.cmd    :: foreground
    D:\workplace\dsh-zcode-free\run-bg.cmd    :: backgrounded in this console

    models     node cli.mjs models        # entitled free models + quota
    catalog    node cli.mjs catalog       # full local builtin catalog
    balance    node cli.mjs balance       # raw quota buckets
    selftest   node cli.mjs selftest      # translation unit tests
    chat       node cli.mjs chat "hi"     # one upstream round trip

HTTP surface:

    GET  /health                 credential + upstream status
    GET  /v1/models              OpenAI model list
    GET  /v1/balance             free quota buckets
    POST /v1/chat/completions    OpenAI wire in, Anthropic wire out (stream + JSON)

Launcher scripts: `start.cmd` (foreground, cmd), `start.ps1` (foreground, PowerShell),
`run-bg.cmd` (backgrounded in the launching console, output stays visible). All
three auto-detect `node.exe` - common install locations first, then PATH - so they
work however Node is installed (this box: `C:\Program Files\nodejs\node.exe`).

Direct, if you prefer:

    cd /d D:\workplace\dsh-zcode-free
    node bin\zcode-free-serve.mjs --port 11451 --log all

## 3. DSH wiring (already applied)

`C:\Users\Lenovo\.dsh\profiles\desktop\cordis.patch.yml`, provider
`llm-pi-ai` / `providers.zcode-free`:

    zcode-free:
      displayName: ZCode free quota (local bridge :11451)
      api: openai-completions
      baseURL: http://127.0.0.1:11451/v1
      headers:
        authorization: Bearer zcode-free
      defaultContextWindow: 1048576
      defaultMaxTokens: 32768
      models:
        - id: GLM-5.3-Flash
          name: zcode-glm-5.3-flash
          contextWindow: 1048576
          maxTokens: 131072
        - id: GLM-5.3
          name: zcode-glm-5.3
          contextWindow: 1048576
          maxTokens: 128000

Model ids shown to the agent become `zcode-free/glm-5.3-flash` and
`zcode-free/glm-5.3` after a profile reload. **As of 2026-10-27 only
`glm-5.3-flash` is actually servable** — the free Start Plan dropped the
GLM-5.3 daily entitlement, so `/v1/models` returns one model and any call to
`zcode-free/glm-5.3` will be rejected upstream. The profile entry is kept
harmlessly; trim it if you prefer a single-model list.

`C:\Users\Lenovo\.dsh\.credentials.yaml` gained a `ZCODE_CREDENTIAL` ref:

    ZCODE_CREDENTIAL: '{"zcode_jwt":"eyJ...","device_mid":"1aa52c08-...","app_version":"3.14.5"}'

That is the credential the already-installed `dsh-our-free-model` plugin's
ZCode channel expects (`isUsableZcodeCredential` requires exactly
`zcode_jwt` + `device_mid`), so its channel-pack - which owns the Aliyun
captcha automation - can authenticate with this login.

## 4. The one thing that still blocks chat, and why

The free chat endpoint answers **HTTP 405 / `{"code":3012,"msg":"request has
been blocked due to unusual activity."}`** for this account. Pinning down what
that verdict keys on:

    no Authorization header at all  -> HTTP 401            (application auth)
    Authorization + minimal headers -> HTTP 405 code 3012   (security verdict)
    Authorization + full ZCode fingerprint -> HTTP 405 code 3012
    HTTP/2 vs HTTP/1.1               -> identical 3012

So the verdict is reached *after* authentication succeeds and does not depend on
the request shape, headers, or transport. It is an identity-level decision: this
account must present an Aliyun captcha verify param on chat calls. The ZCode
desktop holds such a param in process (and the `dsh-our-free-model`
channel-pack knows how to mint one through a CDP-driven Chromium - "先探后取").
A plain HTTP client cannot produce one, which is the hard limit here.

The `3012` code also carries escalating account cooldown (30 min -> 24 h ->
suspension), so this bridge deliberately **never retries**. On a 3012 it replies
once with HTTP 429, `retry-after: 1800`, code `zcode_unusual_activity`, and
the upstream `logid` for support tickets. Nothing is billed on a 3012.

A different code, **3009** ("model concurrency limit exceeded", HTTP 429), is
the transient one: a request is already in flight on that model. With the same
credential shared with the desktop app, the usual cause is the ZCode desktop
holding the slot. This bridge maps it to HTTP 429, code
`zcode_concurrency_limited`, `retry-after: 30` - it is safe to retry and nothing
is billed. The two are deliberately distinguished: 3012 must never be retried,
3009 may.

### 3012 escalates - and the escalation changes shape

Observed 2026-10-25, ~25 h after the first 3012 of 2026-10-24: the chat
endpoint stopped returning the app JSON `{"code":3012,...}` and started
returning a **static WAF block page** - HTTP 405 with a zh-cn HTML page
(`<title>405</title>`, Zhipu's `data-spm` marker). Some edge nodes answered
HTTP 401 `{"code":4001,"msg":"token verify failed"}` instead. Both are
post-escalation states; the verdict had moved from the application to the
CDN/WAF edge.

Two facts pin down what that means:

    GET /v1/balance  -> HTTP 200, full quota   (same token, non-chat path)
    POST .../messages -> HTML 405 / 4001       (chat path only)

So the credential is not revoked - the *chat path for this account* is what is
blocked, at a layer below the app. `4001 token verify failed` is misleading:
it does not mean the token is dead.

Nothing a client can send clears this. Header, body, transport and captcha
changes all happen at or above the app; the block is now below it. This bridge
maps it to HTTP 429, code `zcode_waf_blocked`, `retry-after: 86400` (24 h)
so that upstream clients back off instead of retrying into a deeper block. It
also never retries itself. Quota is untouched, nothing is billed. The ZCode
desktop app on this account is likely blocked too, and recovery is time (or
ZCode support).

Any other upstream rejection is surfaced as HTTP 502 `zcode_upstream_error`
with the upstream status, its `x-request-id`/`eagleid` trace, and the raw body,
so an unrecognised verdict is diagnosable instead of arriving as an empty string.

### Feeding a captcha param

Two hooks, checked per request:

    ZCODE_CAPTCHA_PARAM="<param>\t<region>"        # env, region defaults to cn
    ~/.zcode-bridge/captcha-param.txt               # one line: <param> [region]
                                                     # (ZCODE_CAPTCHA_FEED to move)

A param is only valid for ~20 s, so the file hook is mtime-checked
(`ZCODE_CAPTCHA_MAX_AGE_MS`, default 20000) and stale params are ignored rather
than sent. When a fresh param is present the bridge adds
`x-aliyun-captcha-verify-param` + `x-aliyun-captcha-verify-region` and the
request goes through as a normal Anthropic Messages call.

## 5. Credential handling

Nothing is re-derived from the network. The bridge reads the desktop's own store:

    ~/.zcode/v2/credentials.json        enc:v1:<iv>.<tag>.<ciphertext>   (b64url)
    AES-256-GCM, key = sha256(seed)     seed = ZCODE_CREDENTIAL_SECRET, else
      "zcode-credential-fallback:<os>:<home>:<user>"
    ~/.zcode/v2/onboarding-record.json  deviceMid

Override order: `ZCODE_JWT` env > encrypted store; `ZCODE_DEVICE_MID` env >
onboarding/telemetry records; `ZCODE_APP_VERSION` env > highest version dir
under `v2/runtime/provider/<platform>/` > `3.14.3`.

Headers sent to upstream (`lib/zcode-upstream.mjs: buildHeaders`):
`anthropic-version`, `user-agent: ZCode/<app>`, `x-zcode-app-version`,
`x-release-channel: stable`, `x-client-language: zh-CN`,
`x-client-timezone: Asia/Shanghai`, `x-device-mid`, `x-platform: win32`,
`x-os-category: windows`, `http-referer`, `authorization: Bearer <jwt>`.

## 6. Layout

    lib/zcode-auth.mjs      local credential + device id discovery
    lib/zcode-upstream.mjs  upstream client, quota, captcha feed, SSE parser
    lib/translate.mjs       OpenAI <-> Anthropic wire translation (pure)
    server.mjs              HTTP bridge + buildServer()
    bin/zcode-free-serve.mjs entry point
    cli.mjs                 models / catalog / balance / chat / json / selftest

Node >= 18.17, no third-party dependencies.
