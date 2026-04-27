# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x (latest) | ✅ Active support |
| 1.x (Python) | ❌ End of life — migrate to v2 |

---

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

M4TR1X is used by journalists, activists, and people in high-risk environments. A public disclosure before a patch is ready could put real users in danger.

### How to report

**Preferred — GitHub Private Security Advisory:**
Use GitHub's built-in private reporting:
👉 [Report a vulnerability](https://github.com/H8dboy/m4tr1x-electron/security/advisories/new)

**Alternative — Nostr encrypted DM (NIP-44):**
Send an encrypted DM to the maintainer's npub (see profile). Use a burner Nostr key if you need anonymity.

**Alternative — Email:**
`security [at] h8group [dot] net` *(PGP key available on request via Nostr DM)*

### What to include

- Description of the vulnerability and its impact
- - Steps to reproduce (proof of concept if possible)
  - - Affected version(s) and platform (Windows / macOS / Linux)
    - - Your assessment of severity (see matrix below)
      - - Whether you want credit in the release notes (or prefer anonymity)
       
        - ### Response timeline
       
        - | Stage | Target time |
        - |-------|-------------|
        - | Acknowledgement | ≤ 48 hours |
        - | Severity assessment | ≤ 5 business days |
        - | Patch for Critical/High | ≤ 14 days |
        - | Patch for Medium/Low | ≤ 60 days |
        - | Public disclosure | After patch release + 7 days |
       
        - We follow **coordinated disclosure**. If you give us a reasonable timeline and we miss it, you are free to publish.
       
        - ---

        ## Severity Matrix

        | Severity | Examples |
        |----------|---------|
        | **Critical** | Remote code execution, private key extraction, identity deanonymization |
        | **High** | Local privilege escalation, bypass of Electron sandbox, Tor leak |
        | **Medium** | XSS in renderer (with CSP bypass), CSRF on local API, metadata not stripped |
        | **Low** | Information disclosure without sensitive data, non-exploitable crash |
        | **Informational** | Hardening suggestions, defense-in-depth improvements |

        ---

        ## Scope

        ### In scope
        - `main.js` — Electron main process, IPC handlers, CSP configuration
        - - `preload.js` — contextBridge surface, IPC exposure
          - - `server/` — Express API, authentication, H8 identity/token logic
            - - `frontend/` — XSS, injection, insecure data handling in the renderer
              - - `server/h8identity.js` — key management, encryption/decryption
                - - `server/h8token.js` — ledger integrity, transaction signing
                  - - Tor proxy bypass or traffic leakage
                    - - ONNX model integrity (supply-chain attack on the model file)
                     
                      - ### Out of scope
                      - - Vulnerabilities in Nostr relays, PeerTube instances, or Mastodon servers (report to them directly)
                        - - Physical device seizure (documented in threat model)
                          - - Attacks requiring the user to already have an unlocked session and physical access
                            - - Denial of service against the local API (it's local — the user controls it)
                              - - Issues in outdated or end-of-life versions
                               
                                - ---

                                ## Security Design

                                M4TR1X is built for the worst-case scenario: a user in an authoritarian country, on a seized network, whose device may be inspected.

                                **No central server.** Everything runs locally. There is no M4TR1X cloud that can be seized, subpoenaed, or compelled to hand over data.

                                **Tor-first networking.** If Tor Browser or the tor daemon is running at launch, M4TR1X automatically routes all outbound traffic through SOCKS5. No manual configuration required.

                                **Post-quantum identity (ML-DSA65 / CRYSTALS-Dilithium).** Every H8 identity uses NIST FIPS-204 key pairs. The secret key is encrypted at rest with AES-256-GCM + scrypt and never leaves the device. In-session keys live in memory only and are wiped on app close.

                                **End-to-end encrypted DMs.** Direct messages use Nostr NIP-44 (ChaCha20-Poly1305 + ECDH secp256k1). No relay can read them.

                                **Metadata scrubbing.** Every video passes through ExifTool before analysis or publishing to strip GPS coordinates, device identifiers, timestamps, and other identifying metadata.

                                **Electron hardening:**
                                - `contextIsolation: true` — renderer process cannot access Node.js APIs
                                - - `nodeIntegration: false` — no Node.js in the frontend
                                  - - `sandbox: true` — Chromium sandbox enforced
                                    - - `webSecurity: true` — same-origin policy enforced
                                      - - CSP via `onHeadersReceived` — blocks XSS and inline script injection
                                        - - `setWindowOpenHandler` — all external links open in the system browser, never in-app
                                          - - Navigation to external URLs is intercepted and blocked
                                           
                                            - **Admin API protection.** Admin endpoints are protected by `localhostOnly` middleware + `ADMIN_KEY` secret. They are never exposed on the network interface.
                                           
                                            - ---

                                            ## Threat Model

                                            ### Protects against
                                            - Network surveillance and traffic analysis (via Tor)
                                            - - Metadata-based device fingerprinting (via ExifTool)
                                              - - Content injection and XSS (via CSP + context isolation)
                                                - - Future quantum computer attacks on identity (via ML-DSA65)
                                                  - - Centralized censorship and deplatforming (via Nostr/PeerTube/Funkwhale federation)
                                                    - - AI-generated disinformation (via ONNX detection + crowd voting)
                                                     
                                                      - ### Does NOT protect against
                                                      - - **Device seizure.** If your device is confiscated with an unlocked session, keys in memory may be accessible. Lock the app (wallet lock button) before any risky situation.
                                                        - - **Screen recording or physical observation** of the device.
                                                          - - **A compromised Nostr relay** selectively censoring content. Use multiple relays and verify content signatures.
                                                            - - **A compromised build pipeline.** Verify release checksums (see below) to confirm binaries match the published source.
                                                              - - **Malware on the host system** with elevated privileges.
                                                               
                                                                - ---

                                                                ## Verifying Release Integrity

                                                                Every release is built by GitHub Actions from the public source code. The workflow file is at `.github/workflows/build.yml` — you can inspect it to verify no modification happens between source and binary.

                                                                SHA-256 checksums are published with every release.

                                                                ```bash
                                                                # Linux
                                                                sha256sum --check checksums-linux.txt

                                                                # macOS
                                                                shasum -a 256 --check checksums-mac.txt

                                                                # Windows (PowerShell)
                                                                Get-FileHash m4tr1x-setup.exe -Algorithm SHA256
                                                                ```

                                                                Compare the output against the checksums listed in the GitHub Release notes.

                                                                ---

                                                                ## Known Issues & Accepted Risks

                                                                | Issue | Status | Rationale |
                                                                |-------|--------|-----------|
                                                                | `script-src 'unsafe-inline'` in CSP | ⚠️ Accepted temporarily | Required by inline event handlers in current frontend. Tracked for removal in v3.0 with full nonce-based CSP. |
                                                                | H8 Token ledger is local-only | ℹ️ By design | Trustless cross-user token transfer requires a consensus layer. Planned for v3.x. |

                                                                ---

                                                                *"In the age of synthetic reality, authenticity is the new resistance."*
                                                                *For the Truth. 👁️*
