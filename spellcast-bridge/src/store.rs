use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use spellcast_core::types::MemoryItem;

const SCHEMA_VERSION: i64 = 2;

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("建不了数据目录 {}：{err}", parent.display()))?;
        }
        let connection = Connection::open(path)
            .map_err(|err| format!("打开不了状态库 {}：{err}", path.display()))?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS spellcast_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    schema_version INTEGER NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS spellcast_memory_fts USING fts5(
                    id UNINDEXED,
                    title,
                    text,
                    created_at_ms UNINDEXED,
                    tokenize = 'trigram'
                );",
            )
            .map_err(|err| format!("初始化不了状态库 {}：{err}", path.display()))?;
        Ok(Self { connection })
    }

    pub fn load<T: DeserializeOwned>(&self) -> Result<Option<T>, String> {
        let row = self
            .connection
            .query_row(
                "SELECT schema_version, value FROM spellcast_state WHERE id = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|err| format!("读取状态库失败：{err}"))?;
        let Some((version, value)) = row else {
            return Ok(None);
        };
        if version != 1 && version != SCHEMA_VERSION {
            return Err(format!(
                "状态库版本是 {version}，当前只支持 {SCHEMA_VERSION}；没有覆盖原数据。"
            ));
        }
        serde_json::from_str(&value)
            .map(Some)
            .map_err(|err| format!("状态库内容损坏，未重置：{err}"))
    }

    pub fn save<T: Serialize>(&mut self, value: &T, memories: &[MemoryItem]) -> Result<(), String> {
        let value = serde_json::to_string(value).map_err(|err| format!("序列化状态失败：{err}"))?;
        let transaction = self
            .connection
            .transaction()
            .map_err(|err| format!("开始保存状态失败：{err}"))?;
        transaction
            .execute(
                "INSERT INTO spellcast_state (id, schema_version, value)
                 VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   value = excluded.value",
                params![SCHEMA_VERSION, value],
            )
            .map_err(|err| format!("写入状态失败：{err}"))?;
        reindex_memories(&transaction, memories)?;
        transaction
            .commit()
            .map_err(|err| format!("提交状态失败：{err}"))
    }

    pub fn reindex(&mut self, memories: &[MemoryItem]) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|err| format!("开始重建记忆索引失败：{err}"))?;
        reindex_memories(&transaction, memories)?;
        transaction
            .commit()
            .map_err(|err| format!("提交记忆索引失败：{err}"))
    }

    pub fn recall(&self, query: &str, limit: usize) -> Result<Vec<MemoryItem>, String> {
        let query = query.trim();
        let pattern = format!("%{}%", escape_like(query));
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, title, text, created_at_ms
                 FROM spellcast_memory_fts
                 WHERE ?1 = '' OR title LIKE ?2 ESCAPE '\\' OR text LIKE ?2 ESCAPE '\\'
                 ORDER BY CAST(created_at_ms AS INTEGER) DESC
                 LIMIT ?3",
            )
            .map_err(|err| format!("准备记忆检索失败：{err}"))?;
        let rows = statement
            .query_map(params![query, pattern, limit as i64], |row| {
                Ok(MemoryItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    text: row.get(2)?,
                    created_at_ms: row.get::<_, i64>(3)?.max(0) as u64,
                })
            })
            .map_err(|err| format!("检索记忆失败：{err}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取记忆结果失败：{err}"))
    }
}

fn reindex_memories(
    transaction: &rusqlite::Transaction<'_>,
    memories: &[MemoryItem],
) -> Result<(), String> {
    // ponytail: rebuild the small local index atomically; switch to row-level updates only if measured.
    transaction
        .execute("DELETE FROM spellcast_memory_fts", [])
        .map_err(|err| format!("清空旧记忆索引失败：{err}"))?;
    let mut insert = transaction
        .prepare(
            "INSERT INTO spellcast_memory_fts (id, title, text, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(|err| format!("准备记忆索引失败：{err}"))?;
    for memory in memories {
        insert
            .execute(params![
                memory.id,
                memory.title,
                memory.text,
                memory.created_at_ms as i64
            ])
            .map_err(|err| format!("写入记忆索引失败：{err}"))?;
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn corrupt_state_is_rejected_without_being_replaced() {
        let path = std::env::temp_dir().join(format!(
            "spellcast-corrupt-state-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let store = Store::open(&path).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO spellcast_state (id, schema_version, value) VALUES (1, 1, 'not-json')",
                [],
            )
            .unwrap();

        assert!(store.load::<Value>().is_err());
        let value: String = store
            .connection
            .query_row(
                "SELECT value FROM spellcast_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "not-json");
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trigram_index_finds_chinese_and_treats_wildcards_literally() {
        let path = std::env::temp_dir().join(format!(
            "spellcast-memory-search-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut store = Store::open(&path).unwrap();
        let memories = vec![
            MemoryItem {
                id: "one".into(),
                title: "创意提醒".into(),
                text: "角色应该保留一点不合时宜的幽默".into(),
                created_at_ms: 1,
            },
            MemoryItem {
                id: "two".into(),
                title: "literal".into(),
                text: "百分号 % 和下划线 _".into(),
                created_at_ms: 2,
            },
        ];
        store.save(&json!({}), &memories).unwrap();
        assert_eq!(store.recall("不合时宜", 8).unwrap()[0].id, "one");
        assert_eq!(store.recall("%", 8).unwrap()[0].id, "two");
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}
