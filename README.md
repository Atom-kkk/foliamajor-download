<p align="center">
  <img src="./img/visualizer.png" alt="Folia" width="100%" />
</p>

<div align="center">

# Folia（增强分支）

Lyrics Reimagined // 辞曲新境

以全屏沉浸式歌词为核心的在线音乐播放器，本分支在 [上游 folia-major](https://github.com/chthollyphile/folia-major)
基础上扩展了**音源、会员歌兜底、下载与游客模式**。

[简体中文](README.md) | [English](README.en.md)

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

[新增了什么](docs/fork-changes.md)
·
[上游完整说明](README.upstream.md)
·
[技术说明](docs/technical.md)

</div>

> [!IMPORTANT]
> **这是非官方分支**（仓库名 `foliamajor-download`）。上游是 [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)，
> 本仓库与上游作者无关，也未获其背书。上游的 Release、网盘、Discord、AUR、Flatpak 都不属于本分支，
> 那些渠道的安装包也不包含本文档描述的改动。
>
> 本项目以 **AGPL-3.0** 分发（与上游一致），归属与修改声明见 [NOTICE](NOTICE)。

## 这个分支做了什么

上游是一个支持网易云、酷狗、QQ 音乐、Navidrome、本地音乐库（桌面端另有波点、YouTube Music、Spotify）
的全屏歌词播放器。本分支在**不动上游播放与歌词渲染**的前提下，补了四类能力：

| # | 能力 | 一句话 | 详细 |
| --- | --- | --- | --- |
| 1 | **酷我音乐源** | 第四个可搜索的直连源，免登录，桌面端可用 | [§1.1](docs/fork-changes.md#11-酷我音乐可独立搜索的第四个直连源) |
| 2 | **星海音源** | 不搜索，按原平台 id 换一条地址，专做兜底 | [§1.2](docs/fork-changes.md#12-星海音源不搜索只按原平台-id-换地址) |
| 3 | **自定义音源** | 把仓库外任意一个 HTTP 服务接成音源，设置页可测连通 | [§1.3](docs/fork-changes.md#13-自定义音源把仓库之外的一个-http-服务接成-provider) |
| 4 | **会员 / 付费歌兜底换源** | 内置源确定放不出来时，改由第三方源提供这一首的地址 | [§2](docs/fork-changes.md#2-会员--付费歌的兜底换源) |
| 5 | **片段识别** | 平台没标「试听」也可能只给 30 秒，实测字节与时长后按试听处理 | [§2.5](docs/fork-changes.md#25-片段识别不信平台的-preview-标记) |
| 6 | **版本排除** | 伴奏 / 现场 / 翻唱 / DJ 版不当作原版换源，也不当作原版下载 | [§2.4](docs/fork-changes.md#24-同名不同版本必须排除) |
| 7 | **下载** | 播放器槽位与命令面板可下载完整版，主进程落盘 | [§3](docs/fork-changes.md#3-下载) |
| 8 | **游客身份** | 不登录也能看首页推荐、公开歌单、电台与探索页 | [§4](docs/fork-changes.md#4-游客身份) |
| 9 | **聚合搜索** | 搜索第一页同时问活跃源与最多 3 个其它源，去重合并 | [§1.4](docs/fork-changes.md#14-注册与聚合搜索) |
| 10 | **歌词样式按句随机** | 每 4 句换一个歌词动画样式，不再整首一种 | [§5](docs/fork-changes.md#5-歌词样式按句随机) |
| 11 | **细节修正** | 切歌箭头默认常显并放大、QQ 登录未配置时直接说清楚、旧音频缓存清一次 | [§6](docs/fork-changes.md#6-播放器细节) · [§7](docs/fork-changes.md#7-qq-登录后端未配置的识别) · [§8](docs/fork-changes.md#8-音频缓存的首次迁移) |

改动的完整清单（含逐文件说明、判定阈值、为什么这么做、有哪些取舍）在
**[docs/fork-changes.md](docs/fork-changes.md)**。规模：46 个文件被修改（+715 / −88），26 个文件新增（约 3,161 行）。

## 三个新音源怎么用

### 酷我音乐 —— 装上就能用

只要跑的是桌面版（Electron），酷我就在平台列表里，不需要登录、不需要配置。
它经过主进程的窄代理发请求（酷我的搜索端点不给 CORS 头），渲染层只能传参数、URL 由主进程拼死，
所以那三条 IPC 通道不是通用转发。

Web 版没有这层代理，酷我会显示为不可用 —— 这是预期行为，不影响别的源。

### 星海音源 —— 自动兜底，不用手动选

它没有搜索，不会出现在搜索源里，只在「内置源放不出来」时被调用。不配置也能用（桌面版）。

### 自定义音源 —— 接你自己的服务

一个能搜、能给地址的 HTTP 服务就够，服务本身放在仓库之外（自建代理、别人的音乐 API、本机小脚本都行）。

配置有两条路，localStorage 优先：

```js
// 改完刷新页面即可
localStorage.setItem('folia.customSource.v1', JSON.stringify({
  baseUrl: 'http://127.0.0.1:8787',
  token: '',        // 有就随请求发 Authorization: Bearer <token>
  enabled: true,
}))
```

```dotenv
VITE_CUSTOM_SOURCE_BASE=http://127.0.0.1:8787
VITE_CUSTOM_SOURCE_TOKEN=
VITE_LOCKED_SONG_FALLBACK_PROVIDER=custom   # 兜底换源指向谁，留空即 custom
```

也可以直接在界面里配：**设置 → 连接与集成 → 服务 → 自定义音源**。填地址、点「测试连通」
（真发一次搜索请求，所以端口错 / 服务没起 / 缺 CORS 头会分别报出来），再点「保存并重载」。

服务要满足的契约（完整说明见 [`custom/README.md`](src/services/onlineMusic/custom/README.md)）：

```http
GET {base}/search?keyword=<词>&limit=<n>&offset=<n>
  -> { "items": [ { "id": "...", "name": "...", "artist": "A/B", "album": "...",
                    "duration": 245, "cover": "https://..." } ], "total": 120, "hasMore": true }
  # 也认 { "songs": [...] } / { "data": [...] } / 直接一个数组

GET {base}/url?id=<id>&quality=<standard|high>
  -> { "url": "https://...", "quality": "high", "expiresAt": 1760000000000, "preview": false }
  # 也认 { "data": { "url": ... } } / { "playUrl": ... }；404 或 url 为空 = 这首没有可播地址

GET {base}/lyric?id=<id>      # 可选 -> { "lrc": "...", "translated": "..." }
```

服务要允许跨域（`Access-Control-Allow-Origin`）。档位方面本分支**最高只请求到 `high`**：
声明无损只会让缓存把低码率文件记成无损，所以 `lossless` / `hires` 在问这个源之前会被收敛成 `high`。

## 会员歌兜底：什么时候换、换成谁

只在**内置源确定放不出来**时换源，其余情况一律保持内置源行为（包括它自己的报错与重试）。

| 会换 | 不会换 |
| --- | --- |
| 平台自报受限且没有任何可播档位 | 网络错误、超时、平台 5xx |
| `fee=1`（会员）/ `fee=4`（数字专辑）且没买过、当前账号也不是会员 | 已购买的数字专辑、会员账号播 `fee 1` |
| 灰歌（`privilege.st < 0`）且无可播档位 | 下架（换源顶替已下架的歌唱比报错更糟） |
| 有地址但实测是片段（平台没标 preview 也一样） | 本地文件、Navidrome、本来就来自兜底源的歌 |

候选顺序是 **自定义音源（或 `VITE_LOCKED_SONG_FALLBACK_PROVIDER` 指定的源）→ 星海 → 酷我**。
星海在前是因为它按原歌的 id 换地址，不会串版本；酷我要先搜一次，放最后。

换源只换「这一首这一次的地址」：队列、历史、封面、歌词、收藏仍对着原来那一首，`sourceRef` 与缓存键都不变。
想整体关掉：`VITE_LOCKED_SONG_ROUTING=off`。

## 下载

- 播放器控制槽位「下载当前歌曲」（**默认副槽位就是它**，可在设置里换回歌词时间轴）；
- 命令面板：`Download current song`、`Clear cached audio and reload`（后者在缓存是错的版本时用）。

下载只要完整版：先在歌曲自己的源里找，再按原平台 id 问星海，最后跨源按「标题 + 歌手」匹配
（阈值与播放兜底同一个函数，避免「播放换到 B 版、下载却是 A 版」）；全是片段时拒绝，不会存下一个
30 秒的文件。写盘在主进程：保存位置只来自系统对话框，先写 `.part` 再改名，扩展名走白名单。

只在桌面版可用。

## 构建与运行

需要 Node.js ≥ 24。

```bash
git clone https://github.com/<github-owner>/foliamajor-download.git
cd foliamajor-download
npm install
npm run dev            # Web 版（Vite）
npm run dev:electron   # 桌面版（Electron + 热更新）
npm run build          # Web 产物
npm run build:electron # 桌面安装包（electron-builder，输出到 release/）
```

常用检查：

```bash
npm run typecheck      # 类型检查
npm run test:unit      # 单元测试（Vitest）
npm run test:component # 组件测试（Playwright）
```

模型权重、ffmpeg、MNN 运行库等二进制由脚本拉取，不进仓库：`npm run models:fetch`、`npm run build:ffmpeg`。

**打包发布前请先改掉沿用自上游的包信息**（appId、productName、publish 指向、版本号），
清单见 [docs/fork-changes.md §11](docs/fork-changes.md#11-开源--打包发布前必须修改的地方)。

## 与上游同步

仓库的首个提交 `baseline: folia-major upstream snapshot` 是**未修改的上游快照**，本分支的全部改动在它之后，
所以差异随时可以机器复核：

```bash
git log --oneline                # baseline 之后就是本分支的改动
git diff baseline..HEAD --stat   # 改了哪些文件、多少行
```

同步上游建议用 merge 而不是 cherry-pick，冲突集中在 `providerRegistry.ts`、`omni.ts` 与三个语言文件 ——
这三处是本分支改动最密的地方。

## 已知限制

- **酷我、星海只在桌面版可用**：两者的接口都需要主进程代理（CORS / 预检），Web 版会显示为不可用。
- **三个新源最高只到 `high` 档**：原因见上文；要放开需要先有 `/capabilities` 探测。
- **星海不提供歌词**：后端 `lrc` 格式无保证，声明了会盖掉内置源的好词。
- **星海按 id 换址绕不开平台本身的错标**：个别条目音频其实是伴奏，这种情况在搜索列表里换一条同名结果即可。
- **聚合搜索只做第一页**：各源游标不同，混翻会重复或跳条。
- **游客的首页是公开内容**：没有私人 FM、我的歌单、喜欢清单（这些本来就要账号）。

## 目录导览

本分支新增的目录（其余与上游一致）：

```text
src/services/onlineMusic/kuwo/        酷我直连源
src/services/onlineMusic/xinghai/     星海音源（只换址）
src/services/onlineMusic/custom/      自定义音源（含 HTTP 合同说明）
src/services/onlineMusic/routing/     会员 / 付费歌兜底换源
src/services/onlineMusic/guest/       游客身份
src/services/onlineMusic/audioProbe.ts 片段识别
src/services/onlineMusic/songVersionMatch.ts  同名不同版本判定
src/services/downloads/               下载取址与落盘
electron/kuwo/  electron/xinghai/     两个音源的主进程窄代理
electron/downloads/  electron/audioSizeProbe.cjs  下载与字节探测
```

## 法律与免责声明

- 本项目仅供个人学习、技术交流与非营利测试使用，**请勿用于商业用途**。
- 应用中涉及的在线音乐流媒体、歌词、专辑封面及其他内容，版权均归对应权利人所有；本仓库不包含任何音频内容。
- 自定义音源与兜底换源是**通用机制**：用什么服务、播什么内容，由使用者自行决定并自行承担后果。
  请遵守你所在地区的法律与各平台的服务条款，并在条件允许时通过官方平台支持正版音乐。
- 本项目在 AI 的广泛协助下开发，可能存在细微或不易察觉的问题。

## 许可证与致谢

本项目以 **AGPL-3.0** 分发，与上游一致。原始著作权归 [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)
及其贡献者所有；本分支的修改同样以 AGPL-3.0 授权。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

上游的完整功能说明、部署方式、模组系统、Sync Server、桌面端细节见 [README.upstream.md](README.upstream.md)。

感谢上游作者与贡献者，以及这些项目和资源：

- [chenmozhijin/LDDC](https://github.com/chenmozhijin/LDDC)
- [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- [chenglou/pretext](https://github.com/chenglou/pretext)
- [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)
- [paper-design/shaders](https://github.com/paper-design/shaders)
- [yakult-green-tea/qq-music-api](https://github.com/yakult-green-tea/qq-music-api)
- [AMLL TTML 逐词歌词库](https://github.com/amll-dev/amll-ttml-db)

酷我源的接口细节参考了 LX Music 自定义源生态中的实现（`xzh767/lxmusic-source-all` 的「無名 v0.0.3」
直连酷我部分），星海音源的协议参考了 LX 自定义源「星海音乐源 v3.2.15」。这些参考只用于理解接口形状，
代码是照本仓库的 provider 契约重写的。
