# Block

Personal unpacked Chrome extension that blocks ads with Manifest V3 declarativeNetRequest rules. YouTube video ads are removed in the page, because those requests use the same addresses as the video.

## Setup

Requires Node.js.

```powershell
npm install
npm run compile-filters
npm run build
```

In `chrome://extensions`, turn on Developer mode and choose **Load unpacked**. Select `.output\chrome-mv3`.

After a code change, run `npm run build` and press **Reload** on the Block card. After a filter change, run `npm run compile-filters` first, then build and reload. Removing the card and loading it again clears paused sites and custom filters.

`npm run dev` rebuilds the extension in WXT's browser while you edit. Static filter lists still need `compile-filters`, `build`, and a reload.

## Scripts

- `npm run compile-filters` downloads EasyList, EasyPrivacy, Peter Lowe, and the default uBlock lists, then writes the rules under `public/`.
- `npm run build` writes the extension to `.output\chrome-mv3`.
- `npm run check` runs the filter-parser checks.
