<p align="center">
  <img src="./img/visualizer.png" alt="Folia" width="100%" />
</p>

<div align="center">

# Folia (enhanced branch)

Lyrics Reimagined

An online music player built around full-screen immersive lyrics. This branch extends
[upstream folia-major](https://github.com/chthollyphile/folia-major) with **more sources, a fallback for
permission-locked songs, downloads, and guest mode**.

[简体中文](README.md) | [English](README.en.md)

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[What changed](docs/fork-changes.md)
·
[Upstream README](README.upstream.en.md)

</div>

> [!IMPORTANT]
> **Unofficial fork.** Upstream is [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major).
> This repository is not affiliated with, nor endorsed by, the upstream author. Upstream releases,
> mirrors, Discord, AUR and Flatpak packages do not belong to this branch and do not contain the changes
> described here.
>
> Distributed under **AGPL-3.0**, same as upstream. See [NOTICE](NOTICE) for attribution and the
> modification statement.

## What this branch adds

| # | Capability | In one line |
| --- | --- | --- |
| 1 | **Kuwo source** | A fourth searchable built-in source, no sign-in, desktop only |
| 2 | **Xinghai source** | No search; swaps an address by the original platform id, used as a fallback |
| 3 | **Custom source** | Plug any HTTP service outside the repo in as a provider; testable from settings |
| 4 | **Fallback for locked songs** | When a built-in source provably cannot serve the full track, another source provides that one address |
| 5 | **Clip detection** | A platform may hand out a 30-second URL without saying so; bytes and duration are measured |
| 6 | **Version exclusion** | Instrumental / live / cover / DJ versions are never taken for the original |
| 7 | **Download** | Player slot and command palette save the full track; the write happens in the main process |
| 8 | **Guest mode** | Home recommendations, public playlists, radio and explore work without signing in |
| 9 | **Aggregate search** | The first page asks the active source plus up to three others, merged and deduplicated |
| 10 | **Per-line random lyric style** | A different lyric animation every 4 lines instead of once per song |
| 11 | **Smaller fixes** | Track-switch arrows visible by default, honest QQ "backend not configured" message, one-time legacy audio cache reset |

The full list — per-file notes, thresholds, reasoning and trade-offs — is in
**[docs/fork-changes.md](docs/fork-changes.md)** (Chinese). Scale: 46 files modified (+715 / −88),
26 files added (~3,161 lines).

## The three new sources

**Kuwo** works out of the box on the desktop build: no sign-in, no configuration. It goes through a
narrow main-process proxy because its search endpoint sends no CORS header; the renderer can only pass
parameters, the URLs are built in the main process, so those channels are not a general-purpose relay.
The web build has no such proxy, so Kuwo reports itself unavailable there.

**Xinghai** has no search and never appears among search sources. It is only asked when a built-in
source cannot serve a track. No configuration needed on desktop.

**Custom source** is any HTTP service that can search and hand out addresses — a self-hosted proxy,
someone else's music API, or a small local script. Configure it in the app
(Settings → Connections & integrations → Services → Custom source), where "Test" sends a real search
request and "Save and reload" persists it, or by hand:

```js
localStorage.setItem('folia.customSource.v1', JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', token: '', enabled: true }))
```

```dotenv
VITE_CUSTOM_SOURCE_BASE=http://127.0.0.1:8787
VITE_CUSTOM_SOURCE_TOKEN=
VITE_LOCKED_SONG_FALLBACK_PROVIDER=custom   # which source the fallback asks; empty means custom
```

Contract (see [`custom/README.md`](src/services/onlineMusic/custom/README.md) for the full version):

```http
GET {base}/search?keyword=&limit=&offset=  -> { "items": [ { "id", "name", "artist", "album", "duration" } ] }
GET {base}/url?id=&quality=                -> { "url": "...", "quality": "high", "preview": false }
GET {base}/lyric?id=                       -> { "lrc": "..." }        (optional)
```

The service must allow cross-origin requests. This branch only ever asks for `standard` / `high`:
declaring lossless would let the cache label a low-bitrate file as lossless, so `lossless` / `hires`
are clamped to `high` before the request goes out.

## When the fallback takes over

Only when the built-in source **provably** cannot serve the full track: the platform reports
`restricted` with no playable level, the track is marked paid (`fee` 1 or 4) and the account is not a
member / has not bought it, it is a greyed-out track, or the address it handed out measures as a clip.
Network errors, timeouts, 5xx responses and taken-down tracks never trigger a swap — a substitute
recording is worse than an honest error.

Order: the configured source (default `custom`) → Xinghai → Kuwo. Xinghai comes before Kuwo because it
swaps the address of the same id and therefore cannot pick a different recording; Kuwo has to search
first and goes last. Only the address of that one playback is swapped: queue, history, cover, lyrics and
likes still point at the original song. Disable it entirely with `VITE_LOCKED_SONG_ROUTING=off`.

## Download

The player control slot "Download current song" (the default secondary slot) and the command palette
(`Download current song`, `Clear cached audio and reload`) both save the **full** track: its own source
first, then Xinghai by id, then a cross-source search matched with the same scoring as the playback
fallback. If every source only has a clip, the download is refused rather than writing a 30-second file.
The main process owns the write: the path comes only from a save dialog, bytes go to a `.part` file that
is renamed on success, and extensions are whitelisted. Desktop only.

## Build

Node.js ≥ 24.

```bash
npm install
npm run dev            # web (Vite)
npm run dev:electron   # desktop (Electron, hot reload)
npm run build          # web bundle
npm run build:electron # desktop installers (electron-builder, output in release/)
```

`npm run typecheck`, `npm run test:unit`, `npm run test:component` for checks. Model weights, ffmpeg and
the MNN runtime are fetched by scripts and never committed.

**Before packaging for distribution, change the package metadata inherited from upstream** (appId,
productName, publish target, version) — checklist in
[docs/fork-changes.md §11](docs/fork-changes.md#11-开源--打包发布前必须修改的地方).

## Staying in sync with upstream

The first commit, `baseline: folia-major upstream snapshot`, is an unmodified upstream snapshot; every
change of this branch comes after it, so the difference is always machine-checkable with
`git diff baseline..HEAD --stat`. Prefer merge over cherry-pick when syncing; conflicts concentrate in
`providerRegistry.ts`, `omni.ts` and the three locale files.

## Known limits

- Kuwo and Xinghai are desktop-only (both need a main-process proxy).
- The three new sources top out at `high` quality, by design.
- Xinghai provides no lyrics (its `lrc` format is not guaranteed).
- Xinghai inherits any mislabelling on the platform side (a track whose audio is actually an
  instrumental); pick another same-name result from search in that case.
- Aggregate search covers the first page only — per-source cursors differ, so paging stays on the
  active source.
- Guest mode shows public content only: no personal FM, no "my playlists", no likes.

## License

**AGPL-3.0**, same as upstream. Original copyright belongs to
[`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major) and its contributors; the
modifications in this branch are licensed under AGPL-3.0 as well. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). Everything else — deployment, mods, sync server, desktop details — is documented in
[README.upstream.en.md](README.upstream.en.md).
