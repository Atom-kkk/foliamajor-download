# 自定义音源（第三方源）与锁歌路由

这个目录里的东西做两件事：

1. 把一个**仓库之外**的 HTTP 服务接成 Omni provider（`customProvider.ts`），于是它能搜歌、能被收藏进队列、
   能被播放，和其它源一样出现在平台列表里。
2. 给「内置源确定放不出来」的歌当兜底（`../routing/lockedSongRouting.ts`）。

服务本身不在这里：它可以是自建代理、别人提供的音乐 API、或者本机一个小脚本。

## 一句流程

```text
播放内置源的一首 VIP / 付费歌
  -> omni.getAudioSource(song, quality)
       1. lockedSongRouting.isLockedForPlayback(song)
            平台自己说 restricted 且没有可播档位？
            fee 1 / 4 且当前账号不是会员（游客也算不是会员）？
            privilege.st < 0 且没有可播档位？
          ——任意一条成立才继续，否则原样走内置源
       2. 用「标题 + 歌手」在这个源里搜一次，够像才用（scoreSongMatch）
       3. 向这个源要地址，拿到就返回
       4. 任何一步不成立 / 出错 -> 回 null，内置源按它原来的样子走（试听地址或报错）
```

不触发的情况，一条一条写清楚：网络错误、超时、平台 5xx、下架（`taken-down`）、
已经买下的数字专辑、会员账号播 `fee 1` 的歌、本地文件、Navidrome、以及本来就来自这个源的歌。

## HTTP 合同

```http
GET {base}/search?keyword=<词>&limit=<n>&offset=<n>
  -> { "items": [ { "id": "...", "name": "...", "artist": "A/B", "album": "...",
                    "duration": 245, "cover": "https://..." } ],
       "total": 120, "hasMore": true }
  # 也认 { "songs": [...] } / { "data": [...] } / 直接一个数组；
  # 时长小于 1000 按秒算，否则按毫秒；artist 也认 artists / singer / singers 与 [{ name }]。

GET {base}/url?id=<id>&quality=<standard|high>&title=&artist=&album=&duration=
  # 服务可选地支持 lossless/hires（合同认这四个值），但本版本只会请求 standard / high，见下面「档位」。
  -> { "url": "https://...", "quality": "high", "expiresAt": 1760000000000, "preview": false }
  # 也认 { "data": { "url": ... } } / { "playUrl": ... }；
  # 404 或 url 为空 = 这个 id 没有可播地址（等于「没有」，不是故障）。

GET {base}/song?id=<id>       # 可选：单曲详情，没有就回 404
GET {base}/lyric?id=<id>      # 可选：{ "lrc": "...", "translated": "..." }
```

429 / 5xx 会被当成「源不可用」，不会污染内置源的失败状态——路由层把兜底的失败全部吞掉，
只在控制台留一行。

## 档位：本版本最高只到 high（有意为之）

`customProvider.playback.audioQualityLevels` 声明的是 **`['standard', 'high']`**。因此：

- 用户在设置里选 `lossless` / `hires` 时，omni 会在**问这个源之前**把这一档 clamp 成 `high`（`audioQualityFor`），
  发出去的请求是 `quality=high`，记进媒体缓存的副本也按 `high` 记——不会出现「128k 的文件被标成无损」。
- **代价**：真有无损的源，在 `/capabilities` 探测出现之前**拿不到 `lossless` 请求**。这是有意牺牲潜力换正确性，
  不是 bug。要恢复：加一个 `GET /capabilities -> { "levels": ["standard","high","lossless"] }`，
  探测结果缓存在模块里（`audioQualityLevels` 在 omni 里是**同步读**的，不能在 getter 里 await），
  默认值仍用这两档，探测到才升级。
- 为什么不干脆声明四档：声明四档会让 omni 把 `lossless` 原样发给源；源若只给 `high` 并如实声明，
  客户端会按**4-严格**抛 `invalid-response`（这一首失败；若是从内置源转投过来的 VIP 歌，则回落到内置源的
  试听/报错），而不是悄悄把 high 记成 lossless。两害相权，少声明两档更可预测。
- **4-严格**的判据（`customSourceClient.fetchCustomAudioSource`）：服务**自己声明**的 `quality` 比请求的档低、
  且不是 `preview` → 抛 `invalid-response`。不声明 `quality` 的服务无法分辨真假，仍按请求的档交付（已知缺口）。

## 配置

二选一，localStorage 优先：

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
VITE_LOCKED_SONG_FALLBACK_PROVIDER=custom   # 也可以指到别的已注册 provider；留空即 custom
```

没有地址时 `customProvider.getAvailability()` 是 `not-configured`：它在平台列表里显示为不可用，
不影响任何内置源，也不会去搜歌。

## 本地跑通的最小服务

只为了验证「能搜、能播」，不放进仓库：

```js
// node mock-custom-source.mjs
import { createServer } from 'node:http';
const songs = [
  { id: 'demo-1', name: 'Demo Song', artist: 'Demo Artist', album: 'Demo', duration: 200,
    cover: '' },
];
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/search') {
    const q = (url.searchParams.get('keyword') || '').toLowerCase();
    return res.end(JSON.stringify({ items: songs.filter(s => s.name.toLowerCase().includes(q)) }));
  }
  if (url.pathname === '/url') {
    // 换成你本机任意一个能直接播放的音频地址（mp3 / flac / m4a）
    return res.end(JSON.stringify({ url: 'http://127.0.0.1:8787/demo.mp3' }));
  }
  res.statusCode = 404;
  res.end('{}');
}).listen(8787);
```

## 边界

- 只在本地学习使用；这个源不做账号、歌单、红心、播放上报，`capabilities` 里那些都是 false。
- 歌曲身份仍然属于它自己的源：`sourceRef = { kind: 'online', providerId: 'custom', mediaId }`，
  缓存键是 `online:custom:<id>`，和内网源完全分开。
- 换源只换「这一首这一次的地址」，队列、历史、封面、歌词、收藏都还对着内置源的那一首。
