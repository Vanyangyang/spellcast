//! Read-only timings against an explicitly supplied repository. No DB or task delivery.
use spellcast_bridge::game_config::{connect_root, RepositoryCache};
use std::{sync::Arc, time::Instant};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let root = connect_root(args.get(1).ok_or("Expected repository root and Zone ID")?)?;
    let zone = args.get(2).ok_or("Expected Zone ID")?;
    let cache = RepositoryCache::default();
    let mut previous = None;
    for (label, refresh) in [
        ("cold", false),
        ("unchanged", false),
        ("explicit_refresh", true),
    ] {
        let start = Instant::now();
        let repository = cache.read(&root, refresh)?;
        let view = repository.zone(zone)?;
        println!(
            "{}",
            serde_json::json!({
                "read": label, "milliseconds": start.elapsed().as_millis(),
                "reused_index": previous.as_ref().is_some_and(|old| Arc::ptr_eq(old, &repository)),
                "zones": repository.zones().len(), "locations": view.locations.len(),
                "sources": view.sources.len(), "issues": view.issues,
                "source_revision": view.source_revision, "runtime_verified": view.runtime_verified,
            })
        );
        previous = Some(repository);
    }
    Ok(())
}
