//! Read-only adapter diagnostic; never creates records or sends a task.
use spellcast_bridge::game_config::{connect_root, Repository};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let root = connect_root(
        args.get(1)
            .ok_or("Usage: inspect-game-zone <repository> <zone-id>")?,
    )?;
    let repository = Repository::read(&root)?;
    let view = repository.zone(args.get(2).ok_or("A Zone ID is required.")?)?;
    let summary = serde_json::json!({
        "zone": view.zone,
        "entry": view.entry,
        "locations": view.locations,
        "routes": view.routes,
        "issues": view.issues,
        "sources": view.sources.iter().map(|source| serde_json::json!({"path": source.path, "hash": source.hash})).collect::<Vec<_>>(),
        "source_revision": view.source_revision,
        "runtime_verified": view.runtime_verified,
        "routed_zones": repository.zones().iter().filter(|zone| zone.routes > 0).count(),
    });
    println!(
        "{}",
        serde_json::to_string(&summary).map_err(|error| error.to_string())?
    );
    Ok(())
}
