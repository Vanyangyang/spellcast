//! Read-only projection diagnostic against an explicitly supplied repository: overview and one
//! zone's relations, with timings. No database, record, proposal or task delivery.
use spellcast_bridge::game_config::{connect_root, RepositoryCache};
use spellcast_bridge::game_projection::{overview, zone_relations, ProjectionCache};
use std::time::Instant;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let root = connect_root(args.get(1).ok_or("Usage: inspect-game-projection <repository> <zone-id>")?)?;
    let zone = args.get(2).ok_or("A Zone ID is required.")?;
    let repositories = RepositoryCache::default();
    let indexes = ProjectionCache::default();
    let mut timings = Vec::new();
    let mut last = serde_json::Value::Null;
    for (label, refresh) in [("cold", false), ("unchanged", false), ("explicit_refresh", true)] {
        let start = Instant::now();
        let repository = repositories.read(&root, refresh)?;
        let index = indexes.read(&root, refresh)?;
        let summary = overview(&repository, &index);
        let view = repository.zone(zone)?;
        let relations = zone_relations(&repository, &index, &view);
        timings.push(serde_json::json!({"read": label, "milliseconds": start.elapsed().as_millis()}));
        last = serde_json::json!({"overview": summary, "zone": {"id": view.zone.id, "name": view.zone.name, "dungeon_id": view.dungeon_id,
            "locations": view.locations, "routes": view.routes, "issues": view.issues, "source_revision": view.source_revision,
            "sources": view.sources.iter().map(|source| serde_json::json!({"path": source.path, "hash": source.hash})).collect::<Vec<_>>()},
            "relations": relations});
    }
    last["timings"] = serde_json::json!(timings);
    println!("{}", serde_json::to_string(&last).map_err(|error| error.to_string())?);
    Ok(())
}
