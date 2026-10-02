use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

#[tauri::command]
async fn mpv_ipc(request: Value) -> Result<Value, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = request;
        return Err("Ankino Diffusion v0.1 cible Windows.".into());
    }

    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let pipe = r"\\.\pipe\ankino-diffusion-mpv";
            let mut last_error = String::new();

            for _ in 0..12 {
                match std::fs::OpenOptions::new().read(true).write(true).open(pipe) {
                    Ok(mut stream) => {
                        let mut payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
                        payload.push(b'\n');
                        stream.write_all(&payload).map_err(|e| e.to_string())?;
                        stream.flush().map_err(|e| e.to_string())?;

                        let mut reader = BufReader::new(stream);
                        let mut line = String::new();
                        reader.read_line(&mut line).map_err(|e| e.to_string())?;
                        if line.trim().is_empty() {
                            return Ok(serde_json::json!({"error":"empty response"}));
                        }
                        return serde_json::from_str::<Value>(&line).map_err(|e| e.to_string());
                    }
                    Err(e) => {
                        last_error = e.to_string();
                        std::thread::sleep(Duration::from_millis(80));
                    }
                }
            }
            Err(format!("IPC mpv indisponible: {last_error}"))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![mpv_ipc])
        .run(tauri::generate_context!())
        .expect("error while running Ankino Diffusion");
}
