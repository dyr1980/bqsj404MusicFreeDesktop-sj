<div align="center">

# 🎵 MusicFree Desktop

**A plugin-based, customizable, ad-free music player**

English | **[简体中文](./README.md)**

</div>

---

> **About this repository**
>
> A modified build of MusicFree | Original author: maotoumao | Maintainer: 不甚解

> [!IMPORTANT]
> **Usage Agreement**
>
> This project is open-sourced under the [AGPL 3.0](./LICENSE) license. Please comply with the license when using or redistributing it, and keep the license file and the copyright notices in the source code.
>
> 1. When packaging or redistributing, please credit the source (this repository: https://github.com/bqsj404/MusicFreeDesktop-sj)
> 2. Use the code legally and compliantly
> 3. If the license changes, it will be updated in this repository without separate notice
>
> <!-- TODO: your own additional terms -->

---

## ✨ Introduction

A plugin-based, customizable, ad-free music player for **Windows**, **macOS**, and **Linux**.

### 📥 Download

👉 [GitHub Releases](https://github.com/bqsj404/MusicFreeDesktop-sj/releases)


---

## 🚀 Features

|       Feature       | Description                                                                                                                                                                                                                                                       |
| :-----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🔌 Plugin-based** | MusicFree is purely a player — it **does not bundle** any music sources. All search, playback, and playlist import features are powered by **plugins**. As long as a plugin exists for a music source on the internet, you can search and play it with MusicFree. |
| **🎨 Customizable** | Customize the app's appearance and background via theme packs, with a brand-new semantic CSS variable system and iframe backgrounds. See [Theme Packs](#-theme-packs) below.                                                                                      |
|   **🚫 Ad-free**    | Open-sourced under AGPL 3.0, and will remain free.                                                                                                                                                                                                                |
|   **🔒 Privacy**    | All data is stored locally. Your personal information is never uploaded.                                                                                                                                                                                          |

**Plugin-supported features**: Search (music / albums / artists / playlists), playback, album details, artist details, single track import, playlist import, lyrics, top lists, recommended playlists, song comments, multi-quality switching (standard / high / super / lossless).

---

## 🔌 Plugins

MusicFree's core capabilities are driven by plugins. The plugin protocol is compatible with the MusicFree Android version, with additional features available on desktop.

### Plugin Repository

- **Example plugins**: TBD
- **Documentation**: TBD

<!-- TODO: your own plugin repository and plugin development docs -->

### Plugin Capabilities

```
Search ─── Music / Albums / Artists / Playlists
Play   ─── Multi-quality switching · Source redirect
Content ── Album details · Artist works · Lyrics · Comments
Discover ─ Top lists · Recommended playlists · Playlist categories
Import ─── Single track import · Playlist import
```

### Plugin Sandbox

Plugins run in a secure sandbox with access to the following built-in modules:

`axios` · `cheerio` · `dayjs` · `big-integer` · `qs` · `he` · `crypto-js` · `webdav`

---

## 🎨 Theme Packs

MusicFree supports full UI customization through theme packs. Two themes are built in: **Light** and **Pure Black (AMOLED)**.

### Theme Pack Structure

A theme pack is a folder (or `.mftheme` archive) containing the following files:

```
my-theme/
├── config.json      # Theme configuration (required)
├── index.css        # Style definitions (required)
├── preview.png      # Preview image (optional)
└── iframes/         # iframe backgrounds (optional)
    └── app.html
```

### config.json

```jsonc
{
    "name": "Theme Name", // Required
    "preview": "#000000", // Preview color or image path
    "description": "Theme description",
    "author": "Author",
    "authorUrl": "https://...",
    "version": "1.0.0",
    "srcUrl": "https://...", // Remote update URL
    "thumb": "@/thumb.png", // Thumbnail
    "blurHash": "LEHV6nWB2yk8pyo...", // Loading placeholder (BlurHash)
    "iframe": {
        "app": "@/iframes/app.html", // Full app background
    },
}
```

> Use `@/` in paths to reference the theme pack root directory.

### index.css — Semantic CSS Variable System

The new version adopts a **semantic CSS variable** design, organized into six categories by visual purpose. Override these variables in `index.css` to define your theme:

|    Category    |       Prefix       | Purpose                            | Examples                                           |
| :------------: | :----------------: | ---------------------------------- | -------------------------------------------------- |
| **Background** |   `--color-bg-*`   | Page, sidebar, modal backgrounds   | `--color-bg-base`, `--color-bg-sidebar`            |
|    **Fill**    |  `--color-fill-*`  | Buttons, interactive element fills | `--color-fill-brand`, `--color-fill-neutral-hover` |
|    **Text**    |  `--color-text-*`  | Text colors at various levels      | `--color-text-primary`, `--color-text-secondary`   |
|   **Border**   | `--color-border-*` | Dividers, borders                  | `--color-border-default`, `--color-border-subtle`  |
|   **Status**   | `--color-status-*` | Info / Warning / Danger / Success  | `--color-status-danger-text`                       |
|   **Shadow**   |    `--shadow-*`    | Elevation shadows                  | `--shadow-sm`, `--shadow-lg`                       |

> For the full list of variables, refer to the built-in theme [`res/builtin-themes/light/index.css`](./res/builtin-themes/light/index.css).

### iframe Backgrounds

Use the `iframe.app` field in `config.json` to set any HTML page as the app background, enabling particle effects, animations, and other visuals that pure CSS cannot achieve. Both local HTML files and remote URLs are supported.

### Theme Pack Examples

Example repository: TBD

---

## 🛠️ Getting Started

### Prerequisites

| Dependency |      Version      |
| :--------: | :---------------: |
|  Node.js   | >= 22.12   |
|    pnpm    |       >= 11       |

### Quick Start

```bash
# Clone the repository (use your own repo URL)
git clone https://github.com/bqsj404/MusicFreeDesktop-sj.git
cd MusicFreeDesktop-sj

# Install dependencies
pnpm install

# Start the app
pnpm start

# Development with DevTools (not opened automatically by default)
pnpm run start:devtools
```

### Available Commands

|          Command          | Description                                         |
| :-----------------------: | --------------------------------------------------- |
|        `pnpm start`       | Launch the app                                      |
| `pnpm run start:devtools` | Launch and open DevTools                            |
|      `pnpm run package`   | Produce an unpacked build (`out/`)                  |
|       `pnpm run make`     | Build installers (no make target on Windows; use package) |
|       `pnpm run lint`     | Run linter                                          |
|      `pnpm run format`    | Format code                                         |

---

## 🤝 Contributing

Contributions are welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) for development guidelines and submission process.

---

## 📸 Screenshots

#### Home

![Home](./.imgs/screenshot-home.png)

#### Search

![Search](./.imgs/screenshot-search.png)

#### Plugin Manager

![Plugin Manager](./.imgs/screenshot-plugin.png)

#### Themes

![Themes](./.imgs/screenshot-theme.png)

#### Settings

![Settings](./.imgs/screenshot-settings.png)

#### Mini Mode

<div align="center">

![Mini Mode](./.imgs/screenshot-minimode.png)

</div>

---

<!-- TODO: your own support / contact channels (WeChat, Bilibili, Xiaohongshu, ...) -->
