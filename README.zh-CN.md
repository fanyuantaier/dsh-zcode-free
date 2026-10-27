# dsh-zcode-free

[English](README.md) · [简体中文](README.zh-CN.md)

本地 **OpenAI 兼容桥**：把 ZCode 免费 *zcode-plan* 额度（`https://zcode.z.ai`）
开放给 DeepSeek Harness，并附带把这些模型注册为 DSH 一等 provider 的接线。

> **背景 / Background** — ZCode（Z.ai 的编程 agent 桌面端）向免费 Start Plan 用户
> **每天发放 3 亿 token** 的免费额度（仅 GLM-5.3-Flash，当日有效；GLM-5.3 目前
> 不再享有每日额度）。本项目把这份额度从桌面客户端里解放出来：本地起一个
> OpenAI 兼容的 HTTP 桥（`:11451`），任何 OpenAI 客户端都能直接调用该模型。

    DSH  -->  pi-ai openai-completions  -->  http://127.0.0.1:11451/v1
                                     (本桥，OpenAI 协议进)
                                          |
                                          v  Anthropic 协议出
        https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages

---

## 1. 当前实测可用状态

| 检查项 | 结果 |
| --- | --- |
| 本地登录发现（`~/.zcode/v2/credentials.json`，AES-256-GCM） | jwt 255 字符，device mid `1aa52c08-...`，app `3.14.5` |
| `GET /api/v1/zcode-plan/billing/balance` | HTTP 200 |
| 经桥 `GET /v1/models` | HTTP 200 - 1 个可用模型（GLM-5.3-Flash）含实时额度 |
| 经桥 `GET /v1/balance` | HTTP 200 - plan + 1 个 bucket |
| OpenAI <-> Anthropic 翻译 | 30/30 断言通过（`node cli.mjs selftest`） |
| `POST /v1/chat/completions` | **HTTP 429 / code 3012** - 上游人机验证门槛；约 24 小时后升级为 WAF 拦截页（429 `zcode_waf_blocked`，`retry-after: 86400`）- 见 §4 |

撰写时的实时额度（2026-10-27，plan `ZCODE GLOBAL BUILD`，
plan id `zcode-v3-start-plan-1027`，status `active`，ends `1793149200`）：

    GLM-5.3-Flash   剩余 287,426,965 / 300,000,000 tokens
    GLM-5.3         免费 Start Plan 无每日额度（权益已移除）

可用模型列表来自额度权益（`capabilities: ["model:glm-5.3-flash"]`），
而非完整内置目录，因此桥永远不会对外宣称一个免费套餐实际不会服务的模型。

## 2. 运行

    D:\workplace\dsh-zcode-free\start.cmd    :: 前台
    D:\workplace\dsh-zcode-free\run-bg.cmd    :: 在当前控制台后台运行

    models     node cli.mjs models        # 可用免费模型 + 额度
    catalog    node cli.mjs catalog       # 完整本地内置目录
    balance    node cli.mjs balance       # 原始额度 bucket
    selftest   node cli.mjs selftest      # 翻译单元测试
    chat       node cli.mjs chat "hi"     # 一次上游往返

HTTP 接口：

    GET  /health                 凭证 + 上游状态
    GET  /v1/models              OpenAI 模型列表
    GET  /v1/balance             免费额度 bucket
    POST /v1/chat/completions    OpenAI 协议进，Anthropic 协议出（流式 + JSON）

启动脚本：`start.cmd`（前台，cmd）、`start.ps1`（前台，PowerShell）、
`run-bg.cmd`（在启动控制台后台运行，输出保持可见）。三者都会自动查找
`node.exe` - 先查常见安装位置，再查 PATH - 因此无论 Node 如何安装都能工作
（本机：`C:\Program Files\nodejs\node.exe`）。

直接启动也可以：

    cd /d D:\workplace\dsh-zcode-free
    node bin\zcode-free-serve.mjs --port 11451 --log all

## 3. DSH 接线（已应用）

`C:\Users\Lenovo\.dsh\profiles\desktop\cordis.patch.yml`，provider
`llm-pi-ai` / `providers.zcode-free`：

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

配置重载后，agent 看到的模型 id 为 `zcode-free/glm-5.3-flash` 与
`zcode-free/glm-5.3`。**截至 2026-10-27，实际只有 `glm-5.3-flash` 可服务** ——
免费 Start Plan 已移除 GLM-5.3 每日权益，因此 `/v1/models` 只返回一个模型，
任何对 `zcode-free/glm-5.3` 的调用都会被上游拒绝。该配置项保留无害；
若偏好单模型列表，可自行删除。

`C:\Users\Lenovo\.dsh\.credentials.yaml` 新增了 `ZCODE_CREDENTIAL` 引用：

    ZCODE_CREDENTIAL: '{"zcode_jwt":"eyJ...","device_mid":"1aa52c08-...","app_version":"3.14.5"}'

这正是已安装的 `dsh-our-free-model` 插件 ZCode 通道所期望的凭证
（`isUsableZcodeCredential` 要求恰好为 `zcode_jwt` + `device_mid`），
因此其 channel-pack（负责阿里云验证码自动化）可以用该登录完成认证。

## 4. 仍然阻塞对话的那一件事，以及原因

该账号访问免费对话接口会返回 **HTTP 405 /
`{"code":3012,"msg":"request has been blocked due to unusual activity."}`**。
定位这个判定依据的排查：

    完全不带 Authorization 头      -> HTTP 401            （应用层鉴权）
    Authorization + 最小头         -> HTTP 405 code 3012   （安全判定）
    Authorization + 完整 ZCode 指纹 -> HTTP 405 code 3012
    HTTP/2 vs HTTP/1.1            -> 同为 3012

因此该判定发生在鉴权成功*之后*，且不取决于请求形态、头或传输方式。
这是**身份级**判定：该账号在对话调用时必须携带阿里云验证码 verify param。
ZCode 桌面端在进程内持有该参数（`dsh-our-free-model` channel-pack 知道
如何通过 CDP 驱动的 Chromium 获取 - "先探后取"）。
纯 HTTP 客户端无法生成该参数，这就是硬性上限。

`3012` 还带有逐级升级的账号冷却（30 分钟 -> 24 小时 -> 封禁），
因此本桥刻意**永不重试**。遇到 3012 时只回复一次 HTTP 429、
`retry-after: 1800`、code `zcode_unusual_activity`，并带上游 `logid`
供工单使用。3012 不计费。

另一个 code **3009**（"model concurrency limit exceeded"，HTTP 429）是瞬时错误：
该模型已有请求在途。与桌面端共用同一凭证时，常见原因是 ZCode 桌面端占着槽位。
本桥将其映射为 HTTP 429、code `zcode_concurrency_limited`、`retry-after: 30`
—— 可安全重试，且不计费。两者被刻意区分：3012 永不重试，3009 可以重试。

### 3012 会升级 —— 且升级后形态改变

2026-10-25 观测到，距 2026-10-24 首次 3012 约 25 小时后：对话接口不再返回
应用层 JSON `{"code":3012,...}`，而是开始返回**静态 WAF 拦截页** ——
HTTP 405，zh-cn HTML 页面（`<title>405</title>`，智谱的 `data-spm` 标记）。
部分边缘节点则返回 HTTP 401 `{"code":4001,"msg":"token verify failed"}`。
两者都是升级后状态；判定已从应用层转移到 CDN/WAF 边缘。

两个事实可以锁定含义：

    GET /v1/balance  -> HTTP 200，完整额度   （同一 token，非对话路径）
    POST .../messages -> HTML 405 / 4001     （仅对话路径）

所以凭证并未被吊销 —— 被拦的是**该账号的对话路径**，层级低于应用。
`4001 token verify failed` 具有误导性：它并不意味着 token 已失效。

客户端发送任何内容都无法解除。头、body、传输与验证码的改动都发生在应用层或之上；
而此刻的封锁在应用层之下。本桥将其映射为 HTTP 429、code `zcode_waf_blocked`、
`retry-after: 86400`（24 小时），让上游客户端退避而不是重试进更深的封锁。
本桥自身也永不重试。额度不受影响，不计费。该账号的 ZCode 桌面端很可能同样被拦，
恢复只能靠时间（或联系 ZCode 支持）。

其它上游拒绝会以 HTTP 502 `zcode_upstream_error` 暴露，附带上游状态码、
其 `x-request-id`/`eagleid` 追踪与原始 body，让未识别的判定可诊断，
而不是变成一个空字符串。

### 喂入验证码参数

每个请求检查两个钩子：

    ZCODE_CAPTCHA_PARAM="<param>\t<region>"        # 环境变量，region 默认 cn
    ~/.zcode-bridge/captcha-param.txt               # 一行：<param> [region]
                                                     # （用 ZCODE_CAPTCHA_FEED 改路径）

参数有效期只有约 20 秒，因此文件钩子会做 mtime 检查
（`ZCODE_CAPTCHA_MAX_AGE_MS`，默认 20000），过期参数会被忽略而不是发出。
存在新鲜参数时，桥会附加 `x-aliyun-captcha-verify-param` +
`x-aliyun-captcha-verify-region`，请求即作为普通 Anthropic Messages 调用通过。

## 5. 凭证处理

不从网络重新推导任何东西。桥读取桌面端自己的存储：

    ~/.zcode/v2/credentials.json        enc:v1:<iv>.<tag>.<ciphertext>   (b64url)
    AES-256-GCM, key = sha256(seed)     seed = ZCODE_CREDENTIAL_SECRET，否则
      "zcode-credential-fallback:<os>:<home>:<user>"
    ~/.zcode/v2/onboarding-record.json  deviceMid

覆盖顺序：`ZCODE_JWT` 环境变量 > 加密存储；`ZCODE_DEVICE_MID` 环境变量 >
onboarding/telemetry 记录；`ZCODE_APP_VERSION` 环境变量 >
`v2/runtime/provider/<platform>/` 下最高版本目录 > `3.14.3`。

发往上游的请求头（`lib/zcode-upstream.mjs: buildHeaders`）：
`anthropic-version`、`user-agent: ZCode/<app>`、`x-zcode-app-version`、
`x-release-channel: stable`、`x-client-language: zh-CN`、
`x-client-timezone: Asia/Shanghai`、`x-device-mid`、`x-platform: win32`、
`x-os-category: windows`、`http-referer`、`authorization: Bearer <jwt>`。

## 6. 目录结构

    lib/zcode-auth.mjs      本地凭证 + 设备 id 发现
    lib/zcode-upstream.mjs  上游客户端、额度、验证码喂入、SSE 解析
    lib/translate.mjs       OpenAI <-> Anthropic 协议翻译（纯函数）
    server.mjs              HTTP 桥 + buildServer()
    bin/zcode-free-serve.mjs 入口
    cli.mjs                 models / catalog / balance / chat / json / selftest

Node >= 18.17，无任何第三方依赖。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
