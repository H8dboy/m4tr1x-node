# Contributing to M4TR1X

M4TR1X is a community project built for people who need it most: journalists, activists, and anyone who needs to document reality without censorship or surveillance. Every contribution matters.

> *"In the age of synthetic reality, authenticity is the new resistance."*
>
> ---
>
> ## Before You Start
>
> Read the [Security Policy](./SECURITY.md) and the threat model. Every decision in M4TR1X is evaluated against a single question: **does this make the tool safer and more useful for someone in a dangerous situation?**
>
> If the answer is no, we don't ship it.
>
> ---
>
> ## Getting Started
>
> ```bash
> git clone https://github.com/H8dboy/m4tr1x-electron.git
> cd m4tr1x-electron
> npm install
> cp .env.example .env   # edit with your ADMIN_KEY etc.
> npm start
> ```
>
> **Requirements:**
> - Node.js 18+
> - - `ffmpeg` — included automatically via `ffmpeg-static` after `npm install`
>   - - ExifTool (optional, for metadata stripping) — [exiftool.org](https://exiftool.org)
>    
>     - ---
>
> ## Project Structure
>
> ```
> m4tr1x-electron/
> ├── main.js              # Electron entry point — CSP, Tor, IPC
> ├── preload.js           # Secure contextBridge (renderer ↔ main)
> ├── server/
> │   ├── index.js         # Express API server — all routes
> │   ├── h8identity.js    # Post-quantum identity (ML-DSA65)
> │   ├── h8token.js       # H8 ledger (hash chain, mint, transfer, tip)
> │   ├── badges.js        # Badge system (request / admin approval)
> │   ├── ai_detector.js   # ONNX AI video detector
> │   ├── core.js          # ExifTool metadata scrubbing
> │   ├── db.js            # SQLite
> │   ├── shop.js          # Decentralized shop (H8 token payments)
> │   ├── nostr.js         # Nostr (NIP-01, NIP-44, NIP-19)
> │   ├── mastodon.js      # Mastodon / ActivityPub
> │   ├── peertube.js      # PeerTube federation
> │   ├── funkwhale.js     # Funkwhale music
> │   └── tor.js           # Tor auto-detection and proxy setup
> ├── frontend/
> │   ├── index.html       # Main app (feed, forum, shop, DM)
> │   ├── auth.html        # Authentication
> │   ├── admin.html       # Admin panel (localhost only)
> │   ├── loading.html     # Splash screen
> │   └── safety.html      # Safety guide (6 languages)
> ├── models/
> │   └── m4tr1x_detector.onnx   # AI model (generate with train/)
> └── uploads/             # Temporary upload directory (gitignored)
> ```
>
> ---
>
> ## How to Contribute
>
> ### Reporting bugs
>
> Open a GitHub issue with:
> - Steps to reproduce
> - - Expected vs actual behavior
>   - - Your OS and Node.js version
>     - - Whether it affects privacy/security (if so, use [private reporting](./SECURITY.md) instead)
>      
>       - ### Submitting code
>      
>       - 1. Fork the repo
>         2. 2. Create a feature branch: `git checkout -b feat/my-feature`
>            3. 3. Write clear, commented code
>               4. 4. Test locally with `npm start`
>                  5. 5. Submit a Pull Request with a description of what it does and why
>                    
>                     6. ### Commit message convention
>                    
>                     7. ```
>                        type(scope): short description
>
>                        Examples:
>                        feat(nostr): add NIP-57 zap support
>                        fix(identity): prevent key from persisting after wallet lock
>                        security: harden CSP script-src with nonce
>                        docs: update threat model for v3
>                        chore: remove debug console.log from server/index.js
>                        ```
>
> ---
>
> ## Security Guidelines for Contributors
>
> These are non-negotiable. PRs that violate these rules will not be merged.
>
> ### Never commit secrets
>
> - **No private keys, seeds, or identity files** — ever. Not even encrypted ones.
> - - **No `.env` files** — use `.env.example` to document variables
>   - - **No tokens, API keys, or passwords** in code, comments, or commit messages
>     - - If you accidentally commit a secret: rotate it immediately, then open an issue
>      
>       - ### Threat-model-aware coding
>      
>       - Every feature must be evaluated through the lens of M4TR1X's threat model:
>       - - Does this feature leak metadata that could identify a user?
>         - - Does this feature make a network request that bypasses Tor?
> - Does this feature store sensitive data outside the encrypted userData path?
> - - Does this feature expose a new IPC channel that could be abused by a malicious renderer?
>  
>   - If you're unsure, ask in the PR.
>  
>   - ### Electron security checklist (for PRs touching main.js or preload.js)
>  
>   - - [ ] `contextIsolation: true` — must never be disabled
>     - [ ] - [ ] `nodeIntegration: false` — must never be enabled
>     - [ ] - [ ] `webSecurity: true` — must never be disabled
>     - [ ] - [ ] `sandbox: true` — must never be disabled
>     - [ ] - [ ] New IPC handlers must validate and sanitize all inputs
>     - [ ] - [ ] New IPC channels must not expose Node.js filesystem/process APIs directly
>     - [ ] - [ ] External URLs must open in system browser via `shell.openExternal`, never in-app
>    
>     - [ ] ### Express API security checklist (for PRs touching server/)
>    
>     - [ ] - [ ] New endpoints that modify state must check authentication (`ADMIN_KEY` or unlocked H8 session)
> - [ ] All user input must be validated and sanitized before use in SQL queries, file paths, or shell commands
> - [ ] - [ ] File uploads must be validated for type, size, and content — never trust MIME type alone
> - [ ] - [ ] Rate limiting must be applied to new endpoints (use existing `express-rate-limit` setup)
> - [ ] - [ ] Admin endpoints must use `localhostOnly` middleware
>
> - [ ] ### Frontend security checklist (for PRs touching frontend/)
>
> - [ ] - [ ] Never use `innerHTML` with untrusted data — use `textContent` or a sanitizer
> - [ ] - [ ] Never store private keys in `localStorage` — use `sessionStorage` and clear on lock
> - [ ] - [ ] Never send H8 identity password or private key to the server API
> - [ ] - [ ] New `fetch()` calls must go to `localhost:8080` only — never to external URLs directly
> - [ ] - [ ] CSP must not be relaxed to accommodate new features — find a CSP-compatible approach
>
> - [ ] ### Dependency security
>
> - [ ] - Do not add dependencies that phone home, have telemetry, or require cloud accounts
> - [ ] - Check `npm audit` before submitting a PR that adds new dependencies
> - [ ] - Prefer packages with minimal dependency trees
> - [ ] - If adding a crypto primitive, use Node.js built-in `crypto` or an audited library — never roll your own
>
> - [ ] ---
>
> - [ ] ## Priority Areas
>
> - [ ] These are the contributions that matter most right now:
>
> - [ ] **AI model training** — The ONNX model needs training data with real vs AI-generated videos. If you have a dataset, open an issue.
>
> - [ ] **Nonce-based CSP** — Replace `script-src 'unsafe-inline'` with a proper nonce implementation. This is the highest-priority security improvement.
>
> - [ ] **Tor bridge support** — Help users in heavily censored countries connect via obfs4/meek bridges.
>
> - [ ] **IPFS integration** — Auto-pin verified videos to IPFS for permanent, censorship-resistant storage.
>
> - [ ] **Mobile app** — React Native + ONNX Mobile port for Android/iOS.
>
> - [ ] **Translations** — Arabic, Farsi, Russian, and other languages of people who need this most. The `safety.html` already supports 6 languages — extend it.
>
> - [ ] **Test suite** — Jest unit tests for `server/h8identity.js` and `server/h8token.js`, integration tests for critical API endpoints.
>
> - [ ] ---
>
> - [ ] ## Code Style
>
> - [ ] - Clear variable names; comments in English or Italian (both fine)
> - [ ] - No secrets in code (use `.env`)
> - [ ] - Error handling on every `async` function
> - [ ] - No `console.log` with sensitive data (keys, seeds, passwords, user content)
> - [ ] - Prefer explicit over clever
>
> - [ ] ---
>
> - [ ] ## Values
>
> - [ ] M4TR1X is built for people who need it most. Privacy is not a feature. It is the foundation.
>
> - [ ] Every line of code in this repository could, in some small way, be the difference between someone telling their story and someone being silenced.
>
> - [ ] Build accordingly.
