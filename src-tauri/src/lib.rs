/**
 * M4TR1X - Tauri Main Library
 *
 * Manages the app lifecycle:
 *  - On desktop:  copies server JS files to app data dir (once), runs
 *                 npm install on first launch, then starts Express server.
 *  - On mobile:   skips the server (frontend uses Nostr relays directly)
 *  - All platforms: exposes IPC commands to the frontend via invoke()
 */

mod commands;

use std::path::Path;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ── Plugins ──────────────────────────────────────────────────────────
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        // ── IPC commands ─────────────────────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::get_platform,
            commands::get_tor_status,
            commands::is_mobile,
        ])
        // ── App setup ────────────────────────────────────────────────────────
        .setup(|app| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                start_express_server(app.handle().clone());
            }

            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running M4TR1X application");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns the full path to node.exe, checking known Windows locations first.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn find_node_exe() -> String {
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];
    for p in &candidates {
        if Path::new(p).exists() {
            return p.to_string();
        }
    }
    "node".to_string()
}

/// Returns the full path to npm.cmd, checking known Windows locations first.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn find_npm() -> String {
    let candidates = [
        r"C:\Program Files\nodejs\npm.cmd",
        r"C:\Program Files (x86)\nodejs\npm.cmd",
    ];
    for p in &candidates {
        if Path::new(p).exists() {
            return p.to_string();
        }
    }
    "npm".to_string()
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

/// Prepares and starts the Express/Node.js server.
///
/// Steps:
///  1. Copy bundled server/ JS files to app_local_data_dir (first run only).
///  2. Run `npm install` in the data dir if node_modules is missing.
///  3. Spawn `node index.js` and keep it alive for the app's lifetime.
///  4. Poll port 8080 until ready, then navigate the window to /app.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn start_express_server(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // ── 1. Resolve paths ─────────────────────────────────────────────────
        let resource_dir = match app.path().resource_dir() {
            Ok(d) => d,
            Err(e) => { eprintln!("[M4TR1X] resource_dir error: {e}"); return; }
        };
        let data_dir = match app.path().app_local_data_dir() {
            Ok(d) => d,
            Err(e) => { eprintln!("[M4TR1X] app_local_data_dir error: {e}"); return; }
        };

        let src_server  = resource_dir.join("server");
        let dest_server = data_dir.join("server");
        let frontend_dir = resource_dir.join("frontend");
        // Marker: written only after a successful npm install.
        let marker = dest_server.join(".installed");

        // ── 2. Copy server JS files + run npm install (first run only) ────────
        if !marker.exists() {
            println!("[M4TR1X] First run — copying server files...");
            let _ = std::fs::create_dir_all(&dest_server);

            // Copy every file from resource server dir (only .js and .json)
            if let Ok(entries) = std::fs::read_dir(&src_server) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(name) = path.file_name() {
                            let _ = std::fs::copy(&path, dest_server.join(name));
                        }
                    }
                }
            }
            println!("[M4TR1X] Server files copied.");

            // ── 3. Run npm install ────────────────────────────────────────────
            println!("[M4TR1X] Running npm install (~20s)...");
            let npm = find_npm();
            match tokio::process::Command::new(&npm)
                .arg("install")
                .current_dir(&dest_server)
                .status()
                .await
            {
                Ok(s) if s.success() => {
                    let _ = std::fs::write(&marker, "ok");
                    println!("[M4TR1X] npm install complete.");
                }
                Ok(s) => {
                    eprintln!("[M4TR1X] npm install failed with status: {s}");
                    return;
                }
                Err(e) => {
                    eprintln!("[M4TR1X] npm install error: {e}");
                    return;
                }
            }
        }

        // ── 4. Start the Node.js server ───────────────────────────────────────
        let node   = find_node_exe();
        let script = dest_server.join("index.js");
        println!("[M4TR1X] Starting server: {} {:?}", node, script);

        let mut child = match tokio::process::Command::new(&node)
            .arg(&script)
            .current_dir(&dest_server)
            .env("M4TR1X_FRONTEND_PATH", &frontend_dir)
            .env("M4TR1X_DATA_DIR", &data_dir)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[M4TR1X] Failed to start server: {e}");
                return;
            }
        };

        // ── 5. Poll port 8080, then navigate window ───────────────────────────
        println!("[M4TR1X] Waiting for server on port 8080...");
        let mut ready = false;
        for _ in 0..300u32 {  // max 150 s
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if std::net::TcpStream::connect("127.0.0.1:8080").is_ok() {
                ready = true;
                break;
            }
        }

        if ready {
            println!("[M4TR1X] Server ready — navigating to app");
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = "http://localhost:8080/app".parse() {
                    let _ = window.navigate(url);
                }
            }
        } else {
            eprintln!("[M4TR1X] Timeout: server did not respond within 150 s");
        }

        let _ = child.wait().await;
        println!("[M4TR1X] Server stopped.");
    });
}
