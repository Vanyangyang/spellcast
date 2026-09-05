//! Headless local API used by `npm start` for the browser preview of the board.

use std::net::SocketAddr;
use std::sync::Arc;

use spellcast_bridge::{api, Bridge, Headless, DEFAULT_PORT};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "spellcast_server=info,spellcast_bridge=info".into()),
        )
        .init();

    let port: u16 = std::env::var("SPELLCAST_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let state_path = std::env::var_os("SPELLCAST_STATE_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/preview.sqlite3"));
    let bridge = Arc::new(Bridge::open(Headless, port, state_path).expect("restore preview state"));
    let app = api::router(bridge);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Spellcast preview API on http://{addr}/api");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve");
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
