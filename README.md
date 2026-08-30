# ExtensionSync

Export, import, and synchronize your browser extensions seamlessly across profiles and accounts.

A premium, enterprise-grade **Manifest V3** browser extension for Chromium-based browsers (Brave, Chrome, Edge).

## Features

- **Bulk Export** — Enumerate all installed extensions via `chrome.management.getAll()`, filter out ExtensionSync itself, and package a comprehensive, pretty-printed snapshot (name, id, version, enabled state, permissions, install type, links, icon) into a dated backup file named `yyyy-mm-dd_Extensions_{browser}_{profile}.json`, saved via the downloads API.
- **Secure Import Wizard** — Parse uploaded backup JSON files into an interactive checklist dashboard. A primary neon "Initialize Sync Launch" button sequentially opens the Chrome Web Store installation pages in targeted browser tabs (MV3-safe, since silent background installation is blocked).
- **Cross-Account Cloud Sync** — Serialized payloads are saved to `chrome.storage.sync` and automatically propagate to every browser signed into your account.
- **Custom Endpoint Sync** — Power users can hook up an external database webhook or custom REST API URL; payloads are POSTed as JSON on every refresh.

## Structure

```
manifest.json   MV3 manifest — permissions: management, downloads, storage, identity
background.js   Service worker — event-driven, MV3-safe (no global state)
popup.html      Popup UI — 3-tab layout (Export / Import / Sync)
popup.css       Neon cyber-dark design system
popup.js        All export / import / sync logic
icons/          Extension icons (16 / 48 / 128)
```

## Design

Premium **neon cyber-dark** theme:

- Obsidian dark background (`#0A0A0C`)
- Electric Cyan (`#00E5FF`) for active/success states
- Amethyst Violet / Periwinkle (`#8B7DBE`) for secondary accents
- Razor-thin glowing contours on active tabs, inputs, container edges, and primary buttons
- Extension cards with micro-border glow that intensifies on hover (0.2s ease-in-out)

## Install (Development)

1. Open `chrome://extensions` (Brave/Chrome/Edge)
2. Enable **Developer Mode**
3. Click **Load unpacked** and select this folder

## Usage

1. **Export** — click the toolbar icon → **Export** tab → **Export All**. A dated, readable backup downloads as `yyyy-mm-dd_Extensions_{browser}_{profile}.json`.
2. **Import** — (on another profile/device) drag the backup file onto the Import dropzone, check the extensions you want, then click **Initialize Sync Launch** to open their Web Store install pages.
3. **Sync** — the Sync tab shows last-sync time with a **Force Sync** button, plus a custom endpoint field for webhook/REST integration.

> Note: `chrome.storage.sync` is capped at ~100 KB; the compact JSON is truncated to fit for very large extension sets.

## License

MIT
