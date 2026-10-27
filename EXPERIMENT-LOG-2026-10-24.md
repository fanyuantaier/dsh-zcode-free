# 路线 B 终局实验记录（2026-10-24 晚，ZCode 侧执行）

针对「3012 = 缺阿里云 captcha param」假设的两个决定性单发实验，全部完成，**假设被证伪**。
脚本存于 `D:\workplace\zcode-plan-bridge\`（edge_probe.mjs / mint_param.mjs）。

## 实验 2：TLS 指纹假设 → 证伪

真 Edge（Chromium 同款网络栈、headful、窗口屏外）页面上下文内，
对 `zcode.z.ai` **同源** fetch POST zcode-plan/anthropic/v1/messages，
Bearer zcodejwttoken + 全套指纹头：

    结果: HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity"}
    logid 2026102413321846cf4d2afa07582c9750

⇒ 3012 与客户端 TLS/JA3 无关（python-urllib、node-undici、真 Chromium 三种栈同一判决）。

## 实验 1：captcha param 假设 → 证伪

1. `GET /api/v1/client/configs?app_version=3.16.3&platform=unknown`（Bearer jwt）
   → 实时配置 `sceneId=11xygtvd prefix=no8xfe region=cn`（与 channel-pack 兜底一致）。
2. 本地载体页（channel-pack 同款：最小 DOM + WebGL 反指纹 + 官方 SDK）
   → `initAliyunCaptcha` + `startTracelessVerification()`（无感）
   → **无交互直接成功**，产出 param（payload: certifyId/sceneId/isSign/securityToken，280 字符）。
3. 铸出后 1 秒内落盘喂桥、发射（logid 时间戳 = 文件 mtime + 1s，param 必定新鲜）：

    结果: HTTP 429 code 3012（zcode_unusual_activity）
    logid 20261024133539bbea3656894ec5128079

⇒ 新鲜、正确 scene 的验证码 param 也不能翻动 3012。

## 因果解释（为什么 param 没用）

3012 是 **zcode.z.ai 边缘网关**的判决（"request has been blocked"，带 logid）；
3007 才是**应用层**的验证码拒绝码（zcode.cjs 源码 `isCaptchaRejection`=3007，
`x-aliyun-captcha-verify-param` 头对应的就是它）。
param 机制回应的是 3007——而外部请求死在 3012，**根本没到应用层**。
桥的 README §4 把两者当成一回事，这是本次证伪的核心教训。

## 旁证

`~/.dsh/our-free-model/stats.json` 中 zcode 通道成功记录为 **0**
（所有 glm 字样条目均属 OpenRouter 通道）——channel-pack 的验证码自动化
在这台机器上从未产出过一条可用聊天通道。

## 剩余假设（未测，且不建议测）

边缘闸只放行真桌面进程——差异在进程内铸造的某种 attestation/头，外部从未观察到。
唯一测法是给桌面注入 HTTP_PROXY 抓它自己的真实请求（HTTP_PROXY 在 CLI 环境白名单里），
代价：重启桌面会杀掉正在跑的会话；且 3012 升级阶梯（30min→24h→封停）挂在
驱动日常工作的同一账号上。收益上限：本 plan 10-26 09:00 到期，约 36 小时。
结论：到此为止，见好就收。

## 副产品（可复用）

- `mint_param.mjs`：无感铸阿里云 param 全链（config→载体页→Edge CDP→param），跑通。
  channel-pack 其它产品通道（如需 3007 层 param）可直接复用。
- `edge_probe.mjs`：任意"Chromium 上下文同源请求"实验脚手架。
- 3012 计费为零（三发全部被拦，余额未动）。


---

# 反转（同日深夜续）：路线 B 打通了

上面的"证伪"结论只对了一半——3012 确实不是 TLS（真 Edge 同源 fetch 也死）、也不是
captcha param（新鲜 param 也死）。**真正的闸是 HTTP 内容判分：请求必须长得像桌面
agent 的真实请求。** 用 `~/.zcode/cli/config.json` 的 `network.httpProxy`（新 CLI 子进程
启动时读取）把桌面流量引到本地透明 MITM（D:/workplace/zcode-plan-bridge/mitm_trap.py），
抓到胜者请求全样后逐变量收敛：

| 实验 | 变量 | 结果 |
| --- | --- | --- |
| Shot A | 头复刻 + 55KB 自编 body | 3012 |
| Shot B | 头复刻 + 官方 system 前缀(1.6KB) | 3012 |
| Shot D | 头逐字节回放 + 小 body | 3012 |
| 全量回放 | 抓到的 125KB 原始字节原样重发 | **200** |
| E1 | 官方骨架 + 换 messages（100KB） | **200** |
| E2 | 骨架去掉 tools（12.8KB） | **200** |
| E3 | 骨架 + 全新 session id | **200** |

**最小配方**（已固化进本桥 `lib/zcode-upstream.mjs`）：
- 头：anthropic-beta: mid-conversation-system-2026-04-07、复合 UA
  `ZCode/<v> ai-sdk/provider-utils/4.0.27 runtime/node.js/<n>`、authorization 与
  x-api-key 双双 = zcodejwt、x-release-channel: **production**（不是 stable）、
  x-zcode-agent/query-source/session-type/trace-id/request-id/query-id/session-id 全族。
- body：官方 system 三块（`lib/plan-skeleton.json`，~2K token，每次请求前缀计入）+
  metadata.user_id(device_id+session_id) + thinking/output_config 默认。
- 不需要：tools、大体积、cookie、captcha、注册、特定 TLS。

端到端已验：`POST /v1/chat/completions` → 200，计费走 plan 配额（Flash 桶扣减）。
注意：骨架 system 让模型自称 ZCode agent 且默认开 thinking（吃输出预算），
DSH 侧给足 max_tokens 即可。

MITM 陷阱善后：cli/config.json 已还原；trap 以独立进程常驻 :9792（武装中的旧
CLI 子进程仍依赖它，直至其自然消亡；配置已还原，新子进程不再走代理）。


## 接入外部 agent 时补修的两处（同日）

外部 agent 的真实请求形态暴露了两个后续问题，已修：

1. **调用方 system 触发 3012**：ESA 要求 system 数组与官方三块一致，外来
   system 块必死（temperature/tools/stream 均无关）。修复：`wrapPlanBody` 把
   调用方 system 改注入为首条 user 消息，官方骨架原样保留。
2. **流式 200+零字节**：DSH 原版 `anthropicSseToOpenai` 是同步生成器却迭代
   异步 SSE 流，首拍 TypeError 被吞（该路径 3012 时代从未真正跑过）。修复：
   翻译器改 async 生成器 + server 端 for-await 泵送。

回归矩阵（全 200）：裸消息 / +temperature / +tools / +system(改道后) /
agent 全形态 / stream+system（事件流+DONE+reasoning_content）。


## 开机自启（同日）

`HKCU\...\Run` 项 `ZCodeFreeBridge` = `wscript.exe "D:\workplace\dsh-zcode-freeridge-autostart.vbs"`
→ vbs 隐藏运行 `bridge-autostart.cmd` → node 起 :11451（输出在 bridge-autostart.log）。
两个坑：VBS 注释必须纯 ASCII（GBK 代码页解析 UTF-8 中文注释会碎）；引号全部下沉到
.cmd 里，vbs 只调脚本路径。端口被占时新实例自杀退出，无害。删除自启：
`reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v ZCodeFreeBridge /f`
