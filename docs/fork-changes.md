# 本分支相对上游的改动清单

这份文档逐项说明本分支对上游 `chthollyphile/folia-major` 做了什么、为什么这么做、边界在哪。
想知道「多了什么」只看这一份就够；想知道「怎么用」看 [README](../README.md)。

## 0. 基准与统计

| 项 | 值 |
| --- | --- |
| 上游 | [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)，`0.7.21` |
| 许可证 | AGPL-3.0（未改，见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)） |
| 上游快照 | 首个提交 `baseline: folia-major upstream snapshot`（未做任何修改） |
| 修改 | 46 个已跟踪文件，`+715 / -88` 行 |
| 新增 | 26 个文件，约 3,161 行（另有 2 个构建用二进制，不入仓库） |

复核方式：

```bash
git log --oneline                      # baseline 之后就是本分支的改动
git diff baseline..HEAD --stat         # 改了哪些文件、多少行
```

新增目录一览：

```text
src/services/onlineMusic/kuwo/        酷我直连源（搜索 / 取址 / 歌词）
src/services/onlineMusic/xinghai/     星海音源（只按 id 换地址）
src/services/onlineMusic/custom/      自定义（第三方 HTTP）音源 + 合同文档
src/services/onlineMusic/routing/     会员 / 付费歌的兜底换源
src/services/onlineMusic/guest/       游客身份
src/services/downloads/               下载取址与落盘
electron/kuwo/  electron/xinghai/     两个音源的主进程窄代理
electron/downloads/  electron/audioSizeProbe.cjs   下载与片段字节探测
```

---

## 1. 在线音源：从 6 个变成 9 个

上游注册 `netease`、`kugou`、`qq`、`bodian`、`ytm`、`spotify`。本分支追加三个：

| provider id | 名称 | 能搜索 | 能播放 | 能歌词 | 需要登录 | 仅桌面端 |
| --- | --- | --- | --- | --- | --- | --- |
| `kuwo` | 酷我音乐 | 是 | 是 | 是 | 否 | 是 |
| `xinghai` | 星海音源 | 否 | 是（只换址） | 否 | 否 | 是 |
| `custom` | 自定义音源 | 是 | 是 | 是（可选端点） | 否 | 否 |

三个源都遵守原有纪律：只经 `omni.ts`，平台规则留在自己的目录，缓存键各自独立
（`online:kuwo:<id>`、`online:custom:<id>`），不新增旁路。

### 1.1 酷我音乐：可独立搜索的第四个直连源

```text
src/services/onlineMusic/kuwo/kuwo.ts          解析层（纯函数，206 行）
src/services/onlineMusic/kuwo/kuwoProvider.ts  provider 实现（130 行）
electron/kuwo/kuwoIpc.cjs                      主进程窄代理（113 行）
```

- **接口**：搜索 `search.kuwo.cn/r.s`、取址 `nmobi.kuwo.cn/mobi.s?type=convert_url_with_sign`、
  歌词 `m.kuwo.cn/newh5/singles/songinfoandlrc`。实现取自 LX 自定义源「無名 v0.0.3」里
  「直连酷我」那一段，去掉了脚本运行时。
- **为什么必须走主进程**：搜索端点不返回 `Access-Control-Allow-Origin`，渲染进程（`file://`，
  origin 为 `null`）的 `fetch` 到不了。取址和歌词虽然有 CORS，但为了不给渲染层留三套请求方式，
  三条通道统一走 `electron/kuwo/kuwoIpc.cjs`。
- **不是通用转发**：渲染层只能传参数，URL、查询串、请求头都由主进程拼死；参数逐个 clamp
  （`limit` 1–100、`offset` 0–100000、`rid` 只留数字），每请求 12 秒上限，返回 `{ status, text }`，
  解析留在渲染层。这样即便主窗口里跑着注入脚本，也只能打这三个酷我端点，构造不出 SSRF。
- **搜索回答不是 JSON**：酷我回一段单引号 JS 对象字面量。这里用逐字段正则解析（`field()` /
  `rowsOf()`），**绝不 `eval` 远端文本**；`\'` 与常见 HTML 实体（`&nbsp;` 等）会还原。
- **档位只声明 `standard` / `high`**：酷我对 `2000kflac` 的请求经常回 256k，声明无损只会让缓存把
  低档记成无损；实际档位按返回的 `bitrate` 标（`qualityOf()`，≥1000 视为无损、≥192 为 high）。
- `getAvailability` 恒为 `unknown`：这个源从不下架也从不「受限」，有没有地址由取地址那一刻说了算。
- 不需要登录：未登录请求照样给免费歌与一部分会员歌的地址，因此它同时是「会员歌改由第三方提供」的
  天然兜底（见第 2 节）。

### 1.2 星海音源：不搜索，只按原平台 id 换地址

```text
src/services/onlineMusic/xinghai/xinghai.ts          协议层（137 行）
src/services/onlineMusic/xinghai/xinghaiProvider.ts  provider 实现（94 行）
electron/xinghai/xinghaiIpc.cjs                      主进程窄代理（168 行）
```

- 一个 GET 换一个地址：`GET https://yy.zddyr.top/lx/api/?source=<wy|tx|kg|mg|qs>&songmid=…&quality=…`。
- **只接 `netease`(wy) 与 `qq`(tx)**：只列 `mediaId` 能直接当后端 id 用的平台。酷我另由直连源负责；
  第三个平台的 `mediaId` 是 hash，后端要「数字 id + hash」两样，对不上宁可不接。
- **必须走主进程**：后端认 `X-Token` / `X-Client` 两个自定义头，而它的 `OPTIONS` 预检回 405，
  渲染层带自定义头的请求会被浏览器层拦掉。
- **token 自签、30 秒一换**：`X-Token` 是客户端自签的 base64 JSON（`device_id` / `ip` / `timestamp` /
  `random`），服务端会校验 `timestamp`。早期缓存 60 秒正好卡在过期边界，复用到最后一秒就被判过期，
  而 4xx 不重试 —— 表现为「同一首歌一会儿能播、一会儿只剩试听」。现在只复用 30 秒，遇到
  `401/403` 立刻换一枚再试一次。
- **主域名 + 备份域名**：`yy.zddyr.top` 连不上或 5xx 时换 `zrcdy.dpdns.org`。
- 参数白名单固定（`source`/`name`/`singer`/`songmid`/`hash`/`albumId`/`interval`/`albumName`/`quality`），
  同样不是通用转发。
- **不声明歌词能力**：后端回的 `lrc` 格式没有保证，声明了就可能用一份读不出来的词盖掉内置源的好词。
- **不声明 `lossless`**：后端对 flac 的回应不稳定，理由同酷我。

### 1.3 自定义音源：把仓库之外的一个 HTTP 服务接成 provider

```text
src/services/onlineMusic/custom/customSourceConfig.ts   地址 / 令牌 / 开关（101 行）
src/services/onlineMusic/custom/customSourceClient.ts   HTTP 合同与解析（310 行）
src/services/onlineMusic/custom/customProvider.ts       provider 实现（157 行）
src/services/onlineMusic/custom/README.md               合同与最小服务示例（122 行）
src/components/modal/settings/pages/integration/CustomSourceRows.tsx  设置界面（59 行）
src/components/modal/settings/pages/integration/useCustomSource.ts    表单逻辑（141 行）
```

- **合同**（详见 `custom/README.md`）：

  ```http
  GET {base}/search?keyword=&limit=&offset=   -> { items: [...] }（也认 songs/data/数组）
  GET {base}/url?id=&quality=                 -> { url, quality?, expiresAt?, preview? }
  GET {base}/lyric?id=                         -> { lrc, translated? }（可选）
  GET {base}/song?id=                          -> 单曲详情（可选，没有就 404）
  ```

- **配置有两个来源，localStorage 优先**：`folia.customSource.v1 = { baseUrl, token, enabled }`，
  其次 `VITE_CUSTOM_SOURCE_BASE` / `VITE_CUSTOM_SOURCE_TOKEN`。没地址时 `getAvailability()` 是
  `not-configured`：它在平台列表里显示为不可用，不影响任何内置源，也不会去搜歌。
- **设置页入口**：「设置 → 连接与集成 → 服务 → 自定义音源」。三行：开关、地址、令牌；
  最后一行两个按钮 —— 「测试连通」真发一次 `/search?keyword=test&limit=1`（把「端口错」「没起服务」
  「缺 CORS 头」分辨开，而不是统一显示「音源坏了」），「保存并重载」写进 localStorage 后重载窗口
  （provider registry 在注册时决定可用性，不重载新地址不生效）。
- **档位只到 `high`，并且是有意为之**：`audioQualityLevels` 声明 `['standard','high']`，用户在设置里
  选 `lossless` / `hires` 时，omni 会在问这个源之前 clamp 成 `high`，请求发 `quality=high`，
  缓存副本也按 `high` 记 —— 不会出现「128k 的文件被标成无损」。
- **4-严格**：服务自己声明的 `quality` 比请求档低、且不是 `preview` → 抛 `invalid-response`，
  而不是悄悄把 low 记成 high。不声明 `quality` 的服务无法分辨真假，仍按请求档交付（已知缺口）。
- 没有账号概念（`auth: false`），不参与账号读、歌单、红心、上报。

### 1.4 注册与聚合搜索

`src/services/onlineMusic/providerRegistry.ts`

- 内置平台改成统一经 `registerBuiltIn()` 注册，套一层游客身份（见第 4 节）；
  `custom` 与 `xinghai` 直接 `registerOnlineMusicProvider`。
- 不动 `registerOnlineMusicProvider` 本身的语义：账号层「没人登录 → 账号离开」这条合同对 mod 源与
  测试里的假 adapter 仍然成立，游客是产品层决定，只作用于内置平台。

`src/services/onlineMusic/omni.ts` — `searchSongs` 第一页改成**聚合搜索**：

| 项 | 值 | 理由 |
| --- | --- | --- |
| 附加源上限 | 3 个 | 每个都要一次网络请求，多问一个就多等一截 |
| 单源超时 | 3.5 秒 | 等最慢的那个源，超过就当它没回答 |
| 结果缓存 | 同一查询 5 秒 | 搜索框边打边搜，别为同一个词把每个源再问一遍 |
| 顺序 | `kuwo, qq, kugou, bodian, ytm, spotify` | 先挑不需要登录、地址也稳的 |
| 去重 | 标题+歌手去空白标点、大小写不敏感；**保留活跃源那一条** | 活跃源的封面与元数据最全，界面不该因为聚合掉封面 |

翻页仍走活跃源：每个源的游标不同，混在一起翻会重复或跳条。账号切换期间到的结果按原约定丢弃
（比 generation 与 `activeProviderId`）。

---

## 2. 会员 / 付费歌的兜底换源

这是本分支最核心的一处改动。目标：**内置源确定放不出来的那首歌**，改由第三方源提供地址；
其余一切照旧，绝不为了「能出声」换掉一首别的录音。

### 2.1 什么时候才算「锁定」

```text
src/services/onlineMusic/routing/lockedSongRouting.ts   （303 行）
```

`isLockedForPlayback(song)` 的三条触发条件，任一成立才算：

| 条件 | 含义 |
| --- | --- |
| 平台自报 `restricted` 且 `privilege.pl <= 0` | 平台说受限，且没有任何可播档位 |
| `fee === 1`（会员）或 `fee === 4`（数字专辑），且 `payed !== 1` | 已买过的数字专辑不算；`fee 1` 且当前账号 `vipType > 0` 时也不算（会员不该被降级到第三方源） |
| `privilege.st < 0` 且无可播档位 | 灰歌 |

**不触发**：网络错误、超时、平台 5xx、下架（`state === 'unavailable'`）、已购数字专辑、会员账号播
`fee 1`、本地文件、Navidrome、以及本来就来自这个兜底源的歌。下架特意排除 —— 换源顶替一首已下架的
歌，比直接报错更糟。

### 2.2 取址流程被改了顺序

`omni.getAudioSource` 原来的顺序是「先按 fee/权限判定，再直接问兜底源」，那样一首**本来能完整播放**的歌，
只要被打上 `fee=1` 就再也没机会被内置源回答，直接被换成兜底源的试听。现在的顺序：

```text
1. 先问内置源（原样，含它自己的失败与重试语义）
2. 实测这条地址是不是片段（见 2.5）
3. 只有「没有地址 / 标了 preview / 实测是片段」才问兜底源
4. 兜底也拿不到 → 把片段标成 preview，让界面说「试听」，而不是把 30 秒当整首
5. 兜底失败 → 内置源原来的错误照抛
```

配套细节：

- 收尾只写一处：`finish()` 统一处理 ReplayGain、URL 档位记录、扩展钩子（Folium omni hooks）。
  内置源与兜底源都从这里出去，不会两份收尾各活各的。
- 兜底源的档位先按「它分得清的档」收敛一次再问它，避免「只到 high 的源被问了 lossless，
  给回 high 却被按 lossless 记进缓存」。
- 放在 `omni.getAudioSource` 而不是 `restorePlaybackSource.ts`：它是所有取址路径（直接播放、预取、
  会话恢复、窗口交接）的唯一入口，缓存键、级别记录、ReplayGain、扩展钩子都在它后面。
  改恢复路径会把「缓存命中 / 竞态作废 / 预取」各写一遍，且只在恢复播放时生效。

### 2.3 兜底源候选顺序与匹配

候选顺序（`fallbackProviders`）：

```text
1. VITE_LOCKED_SONG_FALLBACK_PROVIDER 指定的源（默认 custom）
2. 星海音源 —— 按原歌在自己平台上的 id 换地址，不搜索，最快也最稳
3. 酷我 —— 按「标题 + 歌手」跨源搜索，要一次搜索，放最后
```

星海排第二是实测结论：把它挪到酷我后面之后，每首歌都先多付一次搜索，原本能完整播放的歌反而退回试听。
歌本来就来自某条候选源时跳过它（不能兜回自己）。

匹配用 `scoreSongMatch`：

| 判据 | 分数 |
| --- | --- |
| 标题完全一致 | +70 |
| 一方包含另一方 | +40，否则直接 0 |
| 有共同歌手（含「一方包含另一方」） | +25；一个都对不上直接 0 |
| 时长差 ≤3 秒 / ≤8 秒 / >30 秒 | +25 / +12 / −25 |
| 采用阈值 | **85** |

- 括号里的版本说明（live / remix / 伴奏 / 电视剧主题曲…）不参与标题比较。
- 映射记忆：找到记 30 分钟，没找到记 5 分钟（`forgetFallbackLookups()` 供重试前清空）；
  同一首的并发查询合并成一个 `inFlight`。
- 只缓存「哪一首对应哪一首」，不缓存地址（第三方地址带时效）。

### 2.4 同名不同版本必须排除

```text
src/services/onlineMusic/songVersionMatch.ts   （32 行）
```

`isDifferentVersion(original, candidate)` 两道判据：

1. 候选标题里有版本词、原歌没有 —— `live`/`现场`/`演唱会`/`翻唱`/`cover`/`伴奏`/`instrumental`/
   `karaoke`/`消音`/`dj`/`remix`/`混音`/`重制`/`remaster`/`acoustic`/`demo`/`片段`/`铃声`/`钢琴版` 等；
2. 去掉括号后主体一致，但括号里的修饰不同。

没有这道判断，`我们俩 (伴奏)` 与 `我们俩` 的评分几乎持平，会被当成原版放出来。播放兜底与下载
（第 3 节）共用同一个判定，避免「播放换到 B 版、下载却是 A 版」。

### 2.5 片段识别：不信平台的 `preview` 标记

```text
src/services/onlineMusic/audioProbe.ts      （143 行）
electron/audioSizeProbe.cjs                 （60 行）
```

平台没标 `preview`，给的却可能是片段：有的平台直接回一条 30 秒的 URL，`freeTrialInfo` 却是空的。
因此 omni 对**每一首时长 > 60 秒、且未标 preview**的歌都实测一次（一次 HEAD 几十毫秒，比「猜哪些歌
可能受限」可靠 —— 从推荐/歌单进来的歌经常不带 `fee`，按权限标记筛会整批漏掉）。

两道判据，先便宜的后贵的：

| 顺序 | 手段 | 判据 |
| --- | --- | --- |
| 1 | 主进程量字节（HEAD，失败退回 `Range: bytes=0-0` 读 `Content-Range`） | 字节 < 时长(秒) × 6000 → 片段（按 48 kbps 下限算，不会误伤低码率完整文件） |
| 2 | `<audio preload="metadata">` 量时长 | 实际比应有短 20 秒以上**且**不到 70% → 片段 |

渲染层这一侧的三个约束：

- **一个元素、一次一条**：以前每次探测都 `new Audio()`，播放/预取/下载三条路各建一个，几个 media
  元素同时抓解码器和连接，拖进度条时明显卡顿。现在复用同一个元素、探测排队执行。
- 队列有上限（`MAX_PENDING = 2`）：预取会把队列占满，这时宁可「不确定」，也不要让播放的取址排在后面。
- 结果缓存 60 秒；4 秒超时；拿不到一律返回 `null` 按「不确定」处理，绝不凭一个空值把好地址丢掉。

---

## 3. 下载

播放可以接受试听片段，下载不行 —— 存一个 30 秒的文件没有意义。整条链路都建立在这个前提上。

### 3.1 取址：只要完整版

```text
src/services/downloads/fullSource.ts    （117 行）
src/services/downloads/downloadSong.ts  （92 行）
```

`resolveFullAudioSource` 按顺序试：

```text
1. 这首歌自己的源
2. 星海（按原平台 id 换址，不会串到现场版/翻唱版）
3. 其它能搜索的源：按「标题 + 歌手」搜一次，够像才取址（阈值 85，与播放兜底同一个函数）
```

每一步都要「有地址 + 不是 preview + 实测不是片段」，否则换下一个；跨源匹配同样排除
`isDifferentVersion`。搜索型源最多试 4 个，不需要登录的排在前面。

`downloadSong` 在此基础上补一条兜底：**取不到完整版时，用播放缓存里那一份**（至少保证「下的就是你听的」
这一份），仍拿不到才抛 `no-full-version`。

### 3.2 写盘：只在主进程，位置只来自系统对话框

```text
electron/downloads/audioDownload.cjs   （153 行）
```

- 渲染层只交「地址 + 建议文件名 + 扩展名」，**给不了路径**，所以这个通道写不出用户没亲自选过的位置。
- `net.fetch` 流式落盘（走 Electron 的 session，代理与证书策略与播放器一致，也不用把几十 MB 的 Blob
  在页面里过一遍内存）。
- 先写 `.part` 再 `rename`：中途失败不会留下一个看起来完整的文件。
- 扩展名走白名单（`mp3/flac/m4a/aac/wav/ogg/opus`），文件名清洗 Windows/macOS 非法字符、控制字符、
  首尾点，截断 120 字。
- `download-cached-audio`：缓存条目只记 `mimeType`，按它推扩展名，直接把播放器用的那份字节 `copyFile`
  到目标路径 —— 这是「下的不是听的这一首」从根上不会发生的一条路。

### 3.3 入口：播放器槽位 + 命令面板

| 入口 | 位置 |
| --- | --- |
| 播放器控制槽位「下载当前歌曲」 | `src/types/playerControlSlots.ts` 新增 `download`；`playerControlSlotActions.ts` 新增分支 |
| 命令面板「Download current song」 | `src/components/command-palette/commands/downloadCommands.ts` |
| 命令面板「Clear cached audio and reload」 | `src/components/command-palette/commands/cacheCommands.ts` |
| 网格墙面 / TUI | `LatticePlaybackProvider.tsx`、`useAppOverlaysModel.ts` 复用同一条命令 |

- **默认副槽位从「歌词时间轴」改成「下载」**（`DEFAULT_PLAYER_CONTROL_SLOT_SECONDARY`）。
- 下载命令按需 `import` 下载服务：它会碰 provider registry 与媒体缓存，而命令注册表要在 node 环境里
  被单独加载（`commands/index.ts` 的断言与相关测试）。
- 清缓存命令：丢掉当前歌曲的媒体缓存 → 重新经 omni 取址 → 写回 `audioSrc` 从头加载。光删缓存不够，
  播放器可能还握着内存里的 blob。用于「缓存下来的是错的版本」或「文件坏了」。

---

## 4. 游客身份

```text
src/services/onlineMusic/guest/guestAccess.ts   （208 行）
```

**问题**：平台适配器在没人登录时 `getLoginStatus()` 回 `null`，账号层把它读成「没人登录」，
账号整个离开屏幕 —— 于是 `getUserPlaylists` / 喜欢清单这一路没有可用 `userId`，
首页推荐与公开歌单以「provider + userId」为归属，**一条都不读**，未登录首页全空甚至报错。

**做法**：不改任何平台适配器，在 registry 注册时统一包一层 `withGuestAccess()`：

- `getLoginStatus` 永不回 `null`、永不抛错：真登录回真账号，否则回一个**稳定的**游客
  （`id = 'guest'`、昵称「游客」，同一平台永远同一个对象）。
- 游客的 library 读写直接答空（歌单空页、喜欢空集合、`whole: false`、云盘 `null`），不去打扰平台 ——
  平台账号端点对一个不存在的 uid 只会报错，那个错误会被记成账号失败，最后变成界面上的红字。
- `logout` 仍交给平台，失败也不阻止本地退出；`signInRanOut`、扫码登录、诊断、自检等成员原样保留。
- 幂等：同一 provider 重复注册（mod 热重载）不会套第二层，否则 `getLoginStatus` 被包两层、
  `logout` 被调两次。
- 只包有 `auth` 的平台：没有账号概念的源本来就以 `requiresAccount: false` 出现，不该塞假账号。
- 可整层关掉：`setGuestAccessEnabled(false)`；`MODE === 'test'` 时默认关（账号层自己的用例验的正是
  「没人登录 → 账号离开」这条上游语义，不该被产品决策改掉）。

**UI 适配**（以下每一处都是为了让「游客」显示成「未登录」，而不是显示成一个叫「游客」的账号）：

| 文件 | 改动 |
| --- | --- |
| `src/types/onlineMusic.ts` | `ProviderAccountSummary` 新增 `guest?: boolean`；`user` 仍带着游客 id（公开数据要归属），界面靠 `guest` + `status:'anonymous'` 显示未登录 |
| `omni.getAccountSummaries` | 游客的 `status` 报 `anonymous`、`user` 原样带上 |
| `omni.getHomeRecommendations` | 游客跳过 `getPersonalFm`：那一路对匿名会话只会回一首和谁都一样的歌，失败还会把整份 feed 标成 `partial`（于是每次进电台都重读）。只问公开的日推与推荐歌单 |
| `homeSources.ts` | `isGuest` 字段；`hasUser` 改成 `Boolean(user) && !isGuest` |
| `useLibraryHomeOnline*.ts` | 游客的歌单页展示公开推荐（与电台同一份数据），并触发 `radioFeed.ensure()` |
| `Grid3D.tsx` | 未登录也显示在线列表；只有「真的一条都没有」才回到登录面板 |
| `LibraryTuiHome(List).tsx` | 游客先看内容，平台列表改由 F2 打开（未登录时同样可用） |
| `BravaisHomeSources.tsx` / `BravaisHomeExplore.tsx` | 未登录也显示列表；探索页是平台公开推荐页，游客可看，只有「无账户的平台」才没有这一页 |
| `useBravaisHomeAccount.ts` | 读屏名与 title 说「未登录」，不把「游客」当昵称念出来 |
| `LoginScreen.tsx` | 游客那一幅显示成未登录（不显示 `ID: guest`，也不给退出按钮） |

---

## 5. 歌词样式按句随机

原来只有「每首歌换一个样式」。新增「每 N 句换一次」：

| 文件 | 改动 |
| --- | --- |
| `src/stores/useVisualizerSettingsStore.ts` | 新字段 `randomVisualizerModeLines`，键 `random_visualizer_mode_lines`，上限 16 句；`handleSetRandomVisualizerModeLines` |
| `src/hooks/useRandomVisualizerMode.ts` | 两种模式共用一条 hook，由 `linesPerSwitch` 决定谁生效；逐句模式优先（开着逐句还按歌切会互相打断） |
| `src/App.tsx` | 传 `lineIndex: currentLineIndex` 与 `linesPerSwitch` |
| `AppearancePage.tsx` | 「随机切换歌词样式」开关，开 = 每 4 句 |
| `AppearanceSection.tsx` | 播放器面板里的同名开关（同一套机制，按歌词行数触发） |

细节：第一句只记起点、不立刻换（刚开播就切一次很突兀）；每句只处理一次（同一行不重复触发）。

---

## 6. 播放器细节

- **切歌箭头默认常显**：`alwaysShowTrackSwitchButtons` 默认值 `false → true`
  （`usePlayerChromeSettingsStore.ts`）。用户原来的选择仍以本地存储为准，这里只改默认值。
- **箭头样式**：`TrackTitleNavigator.tsx` 从 `h-6 w-6` / 图标 16 改成 `h-7 w-7` / 图标 18；
  常显时给一层淡底（白天 `bg-black/5`、夜间 `bg-white/10`），悬停加深；从不透明 70% 提到 90%。
- 槽位渲染、`dev/probes/*.probe.tsx` 同步补 `onDownload` / `canDownload` 两个上下文字段。

---

## 7. QQ 登录「后端未配置」的识别

```text
src/services/onlineMusic/qq/qqProvider.ts
src/services/onlineMusic/qq/qqLoginFailure.ts
```

后端没有 `QQ_SESSION_SECRET` 时登录路由回 501（曲库与播放照常）。原实现会照常去要二维码，
要到的码没有地方封，登录窗口白转一圈。现在：

- 探到 501 就记 `loginRoutesMissing`，`getLoginMethods()` 回空数组（点进去必定失败的那一步不出现）；
- `startLogin` 直接抛 `unsupported` + `QQ_LOGIN_NOT_CONFIGURED`，登录窗口按「后端这项能力没起来」处理，
  而不是「原因不明，再试一次」；
- `resetQqLoginChannelCache()` 一并复位这个标记。

---

## 8. 音频缓存的首次迁移

`electron/main.cjs` 的 `resetLegacyAudioCacheOnce()`：启动时清一次旧的音频缓存，标记文件
`.cache-reset-v2` 保证只清一次，之后正常按 LRU 回收。

原因：早期版本可能把「兜底换源换错的版本」（例如伴奏）当成整首存下来；而播放一旦命中缓存就不再取址，
于是版本排除、片段判定全被绕过 —— 表现为「怎么改都在放错的那一份」。清一次，让缓存按新规则重建。

---

## 9. 测试与工程配置

新增：

```text
test/unit/onlineMusic/kuwoSource.test.ts     酷我解析（真实回答形状：单引号对象、\'、&nbsp;、20201 这类 bitrate）
test/unit/onlineMusic/xinghaiSource.test.ts  星海解析（200 / 403 / 500 三种回答）
test/unit/onlineMusic/audioProbe.test.ts     片段判定阈值
test/unit/downloads/downloadSong.test.ts     后缀推断、文件名、版本排除
```

调整：

| 文件 | 原因 |
| --- | --- |
| `test/unit/onlineMusic/authMembers.test.ts` | `custom` 没有账号，不在登录成员表里 |
| `test/unit/onlineMusic/platformNamePlaces.ts` | 新增 `omni.ts` 聚合顺序、`xinghai.ts` 平台映射两处平台名记账 |
| `test/unit/i18n/missingTranslation.test.ts` | 槽位解析的上下文多了 `onDownload` / `canDownload` |

环境变量（`.env.example`）：`VITE_CUSTOM_SOURCE_BASE`、`VITE_CUSTOM_SOURCE_TOKEN`、
`VITE_LOCKED_SONG_FALLBACK_PROVIDER`，以及文档里提到的 `VITE_LOCKED_SONG_ROUTING=off`（整体关闭换源）。

类型声明：`src/vite-env.d.ts` 补 `kuwoSearch` / `kuwoAudioUrl` / `kuwoLyric` / `xinghaiAudioUrl` /
`downloadAudio` / `downloadCachedAudio` / `probeAudioSize` 七个桥接方法，`electron/preload.cjs` 同步暴露。

---

## 10. 有意为之的取舍

| 取舍 | 说明 |
| --- | --- |
| 三个新源最高只到 `high` | 宁可少声明两档，也不让缓存把 128k 的文件记成无损。要放开需要先有 `/capabilities` 探测 |
| 星海不声明歌词 | 后端 `lrc` 格式无保证，声明了会盖掉内置源的好词 |
| 兜底只在「确定放不出来」或「实测是片段」时触发 | 网络错误、超时、5xx、下架一律不换源，失败照原样呈现 |
| 聚合搜索只做第一页 | 各源游标不同，混翻会重复或跳条 |
| 游客跳过私人 FM | 匿名会话下它只会回同一首歌，失败还会把整份 feed 标成 partial |
| 换源只换「这一首这一次的地址」 | 队列、历史、封面、歌词、收藏仍对着内置源的那一首；`sourceRef` 不变，缓存键不变 |
| 星海换的是同一个 id 的音频 | 平台上个别本身错标的条目（音频其实是伴奏）它绕不开，这种情况在搜索列表里换一条同名结果即可 |

---

## 11. 开源 / 打包发布前必须修改的地方

本分支的包信息已经改掉一部分（仓库名 `foliamajor-download`），下面这些仍需在公开分发前确认：

| 文件 | 字段 | 现值 | 为什么要改 |
| --- | --- | --- | --- |
| `package.json` | `build.appId` | `top.izuna.foliamajor`（上游值，**未改**） | 与官方安装包同 appId，两个包会互相覆盖/冲突。建议改成 `io.github.<github-owner>.foliamajordownload` 这类只属于自己的 id |
| `package.json` | `build.productName` | `Folia`（上游值，**未改**） | 安装后在系统里与官方同名，用户分不清装的是哪个 |
| `package.json` | `author` | `chthollyphile`（上游值，**未改**） | 会写进安装包元数据；本分支应署自己的名字，上游归属由 `NOTICE` 与 `CONTRIBUTORS.md` 保留 |
| `package.json` / `README*` | `repository`、`build.publish[0].owner` | `<github-owner>` 占位 | 填你的 GitHub 用户名；`publish.repo` 已设为 `foliamajor-download` |
| `package.json` | `version` | `0.7.21` | 与上游同版本号，无法区分；发首个包前改成自己的版本 |
| `package.json` | `desktopName` / `build.linux.executableName` | `folia-major*` | 与 `packaging/linux/folia-major.desktop` 文件名绑定，改名要连文件一起改（不改也能用） |
| `.github/workflows/` | 发布类与 triage 工作流 | 上游 CI | 部分工作流缺 secrets 会失败（不是每次都跑），见下方分类表 |
| `NOTICE` | 维护者与年份 | `<维护者>` 占位 | 填写本分支的著作权人 |

### CI 工作流的处理建议

`.github/workflows/` 里有 14 个上游工作流。它们在 fork 里会不会「跑红」，取决于触发条件和所需凭据
（`GITHUB_TOKEN` 由 GitHub 自动提供，其余 secrets 不会随 fork 复制过来）：

| 文件 | 触发条件 | 在 fork 里的表现 | 缺什么 |
| --- | --- | --- | --- |
| `pr-unit-tests.yml` | 有 PR | 正常 | 无 |
| `docker-stack-check.yml`、`linux-arm64-package-check.yml` | 有 PR | 正常 | 无 |
| `codemap-sync.yml` | push main（除只改 CODEMAP） | 正常，用自己的 token 提交生成物 | 无 |
| `triage-pr.yml`、`triage-stale.yml` | PR / 每天 03:00 | 正常（纯确定性逻辑，不调 LLM） | 无 |
| `triage-issues.yml` | 有 issue | **失败** | `DEEPSEEK_API_KEY` |
| `electron-release.yml` | `realeco-release` 文件变化 / 手动 | **失败**（先过版本校验，再到发布） | `AUR_SSH_PRIVATE_KEY`、`AUR_REPO_SSH_URL` |
| `canary-pre-release.yml`、`release-candidate.yml` | 手动 | **失败** | 同上 |
| `nightly-pre-release.yml` | **每天 02:00 定时** | **每天都失败一次** | 同上 |
| `docker-stack-publish.yml` | `deploy/docker/VERSION` 变化 / 手动 | **失败** | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` |
| `sync-server-docker-publish.yml` | `sync-server/package.json` 变化 / 手动 | **失败** | 同上 |

也就是说：日常真正会持续报错的是 `nightly-pre-release`（每天一次）和 `triage-issues`（有人开 issue 时），
其余发布类平时不触发，一旦你改动对应的版本文件或手动触发才会失败。

这些工作流与应用的运行**无关**：本地 `npm run dev` / `build:electron` 完全不读 `.github`，
源码编译出的程序也不会因为 CI 失败而少一行功能。它们只影响仓库页面的自动化与状态灯。

真正会影响已安装应用的是 `build.publish`：它会写进安装包的 `app-update.yml`，
应用里 `electron/main.cjs` 的 `setupAutoUpdater` 按它查更新 —— 指向上游就会被提示「升级」成官方版本，
等于把 fork 覆盖掉。本分支已改为 `<github-owner>/foliamajor-download`。


许可证**不能**改：上游是 AGPL-3.0，本分支是衍生作品，必须继续以 AGPL-3.0 分发并保留
[LICENSE](../LICENSE) 原文与 [NOTICE](../NOTICE) 中的归属声明。
