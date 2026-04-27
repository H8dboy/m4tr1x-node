# M4TR1X — Tauri v2 Setup Guide

This project has been migrated from Electron to **Tauri v2**.
One codebase → Windows, macOS, Linux, Android, iOS.

---

## Prerequisites

### All platforms
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install Node.js dependencies
npm install
```

### Android
```bash
# Install Android Studio + NDK
# Then:
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm install @tauri-apps/cli@^2  # already in package.json
```

### iOS (macOS only)
```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
# Xcode must be installed from App Store
```

---

## Development

```bash
# Desktop (dev mode with hot reload)
npm run dev

# Android emulator
npm run android:dev

# iOS simulator
npm run ios:dev
```

---

## Production Builds

```bash
# Desktop (builds for your current OS)
npm run build

# Android APK + AAB
npm run build:android

# iOS IPA (macOS only, requires Apple Developer account)
npm run build:ios
```

Build outputs:
- Windows: `src-tauri/target/release/bundle/nsis/`
- macOS:   `src-tauri/target/release/bundle/dmg/`
- Linux:   `src-tauri/target/release/bundle/appimage/`
- Android: `src-tauri/gen/android/app/build/outputs/`
- iOS:     `src-tauri/gen/apple/build/`

---

## Architecture

### Desktop (Windows / macOS / Linux)
- Tauri shell starts `node server/index.js` on port 8080
- Frontend loads from `http://localhost:8080/app`
- All existing features work: AI detection, uploads

### Mobile (Android / iOS)
- No local server (Node.js can't run on mobile)
- Frontend loads from `tauri://localhost` (bundled HTML)
- Features available on mobile:
  - ✅ Nostr feed (direct WebSocket to relays)
  - ✅ Video playback
  - ✅ Profile, follows, notifications
  - ✅ Encrypted DMs (Nostr NIP-44, ChaCha20-Poly1305)
  - ⏳ AI badge (requires server — coming in v2.1)
  - ⏳ Video upload (UI hidden, upload via Nostr relay — coming in v2.1)

---

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | App entry, starts Express server on desktop |
| `src-tauri/src/commands.rs` | IPC commands (replaces Electron preload.js) |
| `src-tauri/tauri.conf.json` | App config (window, CSP, bundle targets) |
| `frontend/m4tr1x-bridge.js` | Universal JS bridge (Tauri + Electron compat) |

