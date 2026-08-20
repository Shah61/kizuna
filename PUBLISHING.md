# Publishing Kizuna Blade

Getting from this repo to a download link on your website.

---

## Step 1 — Put your music in

Drop MP3 files into `content/music/`:

```
content/music/
  Track Name - Artist.mp3
  Another Track.mp3
  README.txt          ← leave this
```

The filename becomes the title in song select, so name them how you want them
read. Every MP3 in this folder is copied into the installer and analysed
automatically the first time each player runs the app. Other formats are ignored.

**Size check before you build.** Roughly 8–10 MB per 4-minute MP3. Ten tracks
is about 90 MB *on top of* the ~120 MB Electron baseline, and that's per
platform. FLAC is 3–5× larger than MP3 — convert to 192–256 kbps MP3 unless you
have a reason not to:

```bash
for f in content/music/*.flac; do ffmpeg -i "$f" -b:a 224k "${f%.flac}.mp3" && rm "$f"; done
```

---

## Step 2 — Build the installers

```bash
npm install
npm run dist:mac
```

Output lands in `release/`:

| File | What it is |
| --- | --- |
| `Kizuna Blade-0.4.0-arm64.dmg` | Apple Silicon installer |
| `Kizuna Blade-0.4.0.dmg` | Intel Mac installer |
| `Kizuna Blade-0.4.0-arm64-mac.zip` | Zip, for auto-update later |

For Windows:

```bash
npm run dist:win
```

**This needs Wine when run from macOS:**

```bash
brew install --cask wine-stable
```

If Wine gives you trouble, the reliable options are (a) run `npm run dist:win`
on an actual Windows machine, or (b) use a cloud Windows VM for ten minutes.
Cross-building Windows installers from macOS is the flakiest part of Electron
packaging — don't burn a day on it.

Bump `"version"` in `package.json` before each release. The version ends up in
the filenames, so leaving it unchanged means every build overwrites the last.

---

## Step 3 — Choose where to host

The build is one large binary per platform. You need somewhere that serves big
files reliably.

| Host | Cost | Notes |
| --- | --- | --- |
| **Your own web host / VPS** | You already pay for it | Full control. Best choice if you're bundling licensed music. |
| **Cloudflare R2** | ~$0.015/GB stored, **no egress fees** | Cheapest at scale. Needs a bucket + public domain binding. |
| **Backblaze B2** | ~$0.006/GB | Free egress via Cloudflare. |
| **Amazon S3** | Cheap storage, **egress costs add up** | A 200 MB download × 1000 people ≈ 200 GB ≈ $18. |
| **GitHub Releases** | Free, 2 GB/file | Easiest by far — but see below. |
| **itch.io** | Free | Built for game distribution, has its own launcher. |

### Read this before picking GitHub or itch.io

Both — and every mainstream host — run DMCA processes. If your build contains
commercial recordings you don't hold distribution rights to, a notice will
remove the release **and break the link on your site**, and repeat notices can
suspend the account. That's the practical risk: not a lawsuit, a dead download
button and possibly a lost repo.

If you are bundling licensed music, make sure your distribution method and
permissions cover every MP3 in `content/music`; the app has no alternate
in-app import library.

---

## Step 4 — Upload

### GitHub Releases

```bash
gh release create v0.4.0 \
  release/*.dmg release/*.exe \
  --title "Kizuna Blade 0.4.0" \
  --notes "First release."
```

Direct link format:
`https://github.com/<user>/<repo>/releases/download/v0.4.0/Kizuna-Blade-0.4.0-arm64.dmg`

### Your own server

```bash
scp release/*.dmg release/*.exe you@yourserver.com:/var/www/html/downloads/
```

Link: `https://yoursite.com/downloads/Kizuna-Blade-0.2.0-arm64.dmg`

Make sure your server sends `Content-Type: application/octet-stream` and
doesn't gzip these — some setups mangle binaries otherwise.

### Cloudflare R2

```bash
npx wrangler r2 object put kizuna/Kizuna-Blade-0.4.0-arm64.dmg \
  --file "release/Kizuna Blade-0.4.0-arm64.dmg"
```

Then bind a custom domain to the bucket in the Cloudflare dashboard so the URL
is `https://downloads.yoursite.com/...` rather than an R2 internal one.

**Rename files to remove spaces** before uploading. `Kizuna Blade-0.4.0.dmg`
becomes `Kizuna%20Blade-0.4.0.dmg` in a URL and breaks some download managers:

```bash
cd release && for f in *.dmg *.exe; do mv "$f" "${f// /-}"; done
```

---

## Step 5 — Put the button on your site

`download-section.html` in this repo is a drop-in block: paste it into your
page, change the three URLs at the top of the script, done. It detects the
visitor's OS, highlights the right button, and shows the others underneath.

The minimal version, if you'd rather write your own:

```html
<a href="https://yoursite.com/downloads/Kizuna-Blade-0.4.0-arm64.dmg" download>
  Download for Mac
</a>
<a href="https://yoursite.com/downloads/Kizuna-Blade-Setup-0.4.0.exe" download>
  Download for Windows
</a>
```

Apple Silicon and Intel Macs need different DMGs. Either offer both, or ship
only the `universal` build — add `"arch": ["universal"]` to the `dmg` target in
`package.json` if you'd rather have one file at roughly double the size.

---

## Step 6 — Installing on your other PC

Visit your page, click the button, run the installer. Two things will happen
the first time, because the app isn't code-signed:

**macOS — "cannot be opened because the developer cannot be verified"**

Right-click the app in Applications → **Open** → **Open**. Once per machine.
Or: `xattr -cr "/Applications/Kizuna Blade.app"`

**Windows — "Windows protected your PC"**

Click **More info** → **Run anyway**.

Your visitors will hit these too, and a meaningful number will bounce. Fixing
it properly costs money:

- macOS: Apple Developer Program, $99/year. Then set `CSC_LINK` and
  `CSC_KEY_PASSWORD` and add notarization credentials.
- Windows: a code-signing certificate, $100–400/year. EV certificates clear
  SmartScreen immediately; standard ones build reputation over time.

Worth it if you're distributing widely. Skip it if this is for you and friends.

---

## Step 7 — Shipping an update

1. Bump `"version"` in `package.json`
2. `npm run dist:mac` (and `dist:win`)
3. Upload the new files
4. Update the URLs on your page

Players keep their settings, scores, and cached track analysis across updates;
the MP3 files themselves live in the app bundle under `content/music`.

If you want silent auto-updates later, `electron-updater` reads from GitHub
Releases or a static file server. It needs the `.zip` target on macOS, which
is already configured.

---

## Quick reference

```bash
npm run dev          # develop
npm run dist:mac     # macOS installers  → release/
npm run dist:win     # Windows installers → release/
npm run dist:all     # both
```

| Where things live | Path |
| --- | --- |
| Bundled music (goes in the build) | `content/music/` |
| Built installers | `release/` |
| Player settings, scores, cached analysis | macOS `~/Library/Application Support/Kizuna Blade/`<br>Windows `%APPDATA%\Kizuna Blade\` |
