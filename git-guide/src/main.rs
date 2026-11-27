use clap::{Parser, Subcommand};
use ignore::{DirEntry, WalkBuilder};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser as MarkdownParser, Tag, TagEnd};
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command as ProcessCommand;
use thiserror::Error;

const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GUIDEBOOK_DOCS: usize = 12;
const DB_SCHEMA_VERSION: &str = "2";

#[derive(Debug, Error)]
enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("repository path does not exist or is not a directory: {0}")]
    InvalidRoot(PathBuf),
    #[error("invalid FTS query: {0}")]
    InvalidQuery(String),
}

#[derive(Parser)]
#[command(
    name = "git-guide",
    version,
    about = "Build and query an agent guidebook from a Git project's Markdown"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan Markdown files and rebuild the local knowledge map.
    Index {
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        db: Option<PathBuf>,
    },
    /// Print a compact guidebook for an agent working in this repository.
    Guide {
        #[arg(default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        db: Option<PathBuf>,
    },
    /// Find relevant documents and sections by full-text query.
    Query {
        query: String,
        #[arg(long, default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value_t = 8)]
        limit: usize,
    },
    /// Show the mapped headings and outgoing Markdown references for a file.
    Show {
        path: PathBuf,
        #[arg(long, default_value = ".")]
        repo: PathBuf,
        #[arg(long)]
        db: Option<PathBuf>,
    },
}

#[derive(Clone, Debug, Serialize)]
struct Heading {
    level: u8,
    title: String,
    anchor: String,
}

#[derive(Clone, Debug, Serialize)]
struct Link {
    target: String,
    label: String,
}

#[derive(Clone, Debug)]
struct Document {
    path: String,
    title: String,
    summary: String,
    usefulness: i64,
    rationale: String,
    bytes: u64,
    modified_ns: i128,
    headings: Vec<Heading>,
    links: Vec<Link>,
    searchable_text: String,
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("git-guide: {error}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), AppError> {
    match cli.command {
        Command::Index { repo, db } => {
            let root = canonical_root(&repo)?;
            let database = db.unwrap_or_else(|| root.join(".finleet/knowledge.sqlite3"));
            let (count, partial, dirty_paths) = index_repository(&root, &database)?;
            println!(
                "{} {count} useful Markdown files{}\nDatabase: {}",
                if partial {
                    "Partially updated"
                } else {
                    "Indexed"
                },
                if partial {
                    format!(
                        " ({} useful Markdown files processed from {dirty_paths} dirty path(s)).",
                        count
                    )
                } else {
                    ".".to_owned()
                },
                database.display()
            );
        }
        Command::Guide { repo, db } => {
            let root = canonical_root(&repo)?;
            let database = open_database(&root, db.as_deref())?;
            print!("{}", guidebook(&database, &root)?);
        }
        Command::Query {
            query,
            repo,
            db,
            limit,
        } => {
            let root = canonical_root(&repo)?;
            let database = open_database(&root, db.as_deref())?;
            print!(
                "{}",
                query_guide(&database, &root, &query, limit.clamp(1, 50))?
            );
        }
        Command::Show { path, repo, db } => {
            let root = canonical_root(&repo)?;
            let database = open_database(&root, db.as_deref())?;
            let relative = if path.is_absolute() {
                path.strip_prefix(&root).unwrap_or(&path)
            } else {
                path.as_path()
            };
            print!("{}", show_document(&database, &relative.to_string_lossy())?);
        }
    }
    Ok(())
}

fn canonical_root(root: &Path) -> Result<PathBuf, AppError> {
    let canonical = fs::canonicalize(root)?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidRoot(canonical));
    }
    Ok(canonical)
}

fn open_database(root: &Path, explicit: Option<&Path>) -> Result<Connection, AppError> {
    let path = explicit
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join(".finleet/knowledge.sqlite3"));
    if !path.exists() {
        return Err(AppError::InvalidRoot(path));
    }
    let conn = Connection::open(path)?;
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version.as_deref() != Some(DB_SCHEMA_VERSION) {
        return Err(AppError::InvalidQuery(
            "database schema is unsupported; run `git-guide index`".into(),
        ));
    }
    Ok(conn)
}

fn index_repository(root: &Path, database: &Path) -> Result<(usize, bool, usize), AppError> {
    if let Some(parent) = database.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(database)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    let has_metadata: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata')",
        [],
        |row| row.get(0),
    )?;
    let prior_schema: Option<String> = if has_metadata {
        conn.query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?
    } else {
        None
    };
    create_schema(&conn)?;
    let indexed_before = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM repositories WHERE root=?1)",
        [root.to_string_lossy().as_ref()],
        |row| row.get::<_, bool>(0),
    )?;
    let git_paths = git_dirty_paths(root);
    let repo_is_dirty = git_paths.as_ref().is_some_and(|paths| !paths.is_empty());
    let dirty_paths: Vec<String> = git_paths
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !is_skipped_path(Path::new(path)) && is_markdown_path(Path::new(path)))
        .collect();
    let partial =
        prior_schema.as_deref() == Some(DB_SCHEMA_VERSION) && indexed_before && repo_is_dirty;
    let paths = if partial {
        dirty_paths.iter().map(|path| root.join(path)).collect()
    } else {
        markdown_paths(root)
    };
    let mut documents: Vec<Document> = paths
        .par_iter()
        .filter_map(|path| parse_document(root, path).ok().flatten())
        .filter(|doc| doc.usefulness > 0)
        .collect();
    documents.sort_by(|a, b| a.path.cmp(&b.path));

    let tx = conn.transaction()?;
    if partial {
        update_dirty_paths(&tx, root, &dirty_paths, &documents)?;
    } else {
        rebuild_index(&tx, root, &documents)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO metadata(key,value) VALUES ('schema_version',?1)",
        [DB_SCHEMA_VERSION],
    )?;
    tx.commit()?;
    Ok((documents.len(), partial, dirty_paths.len()))
}

fn markdown_paths(root: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .ignore(true)
        .git_exclude(true)
        .follow_links(false)
        .filter_entry(|entry| !should_skip_dir(entry))
        .build();
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if is_markdown(&entry)
            && entry
                .metadata()
                .map(|m| m.len() <= MAX_MARKDOWN_BYTES)
                .unwrap_or(false)
        {
            entries.push(entry.into_path());
        }
    }
    entries
}

fn git_dirty_paths(root: &Path) -> Option<Vec<String>> {
    let output = ProcessCommand::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
        ])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_git_status_paths(&output.stdout))
}

fn parse_git_status_paths(status: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = status.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let state = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).replace('\\', "/");
        paths.push(path);
        if state.contains(&b'R') || state.contains(&b'C') {
            if let Some(previous_path) = records.next().filter(|path| !path.is_empty()) {
                paths.push(String::from_utf8_lossy(previous_path).replace('\\', "/"));
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn should_skip_dir(entry: &DirEntry) -> bool {
    if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return false;
    }
    entry.file_name().to_str().is_some_and(|name| {
        matches!(
            name,
            ".git"
                | ".finleet"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".venv"
                | "vendor"
        )
    })
}

fn is_skipped_path(path: &Path) -> bool {
    path.components().any(|component| {
        component.as_os_str().to_str().is_some_and(|name| {
            matches!(
                name,
                ".git"
                    | ".finleet"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".next"
                    | ".venv"
                    | "vendor"
            )
        })
    })
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

fn is_markdown(entry: &DirEntry) -> bool {
    entry.file_type().is_some_and(|kind| kind.is_file())
        && entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
            })
}

fn parse_document(root: &Path, path: &Path) -> Result<Option<Document>, AppError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Ok(None);
    }
    let markdown = fs::read_to_string(path)?;
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let (headings, links) = parse_structure(&markdown);
    let title = headings
        .first()
        .map(|h| h.title.clone())
        .unwrap_or_else(|| title_from_path(path));
    let summary = summary_from_markdown(&markdown);
    let (usefulness, rationale) = usefulness_score(&relative, &markdown, &headings);
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or_default();
    let searchable_text = format!("{title}\n{summary}\n{rationale}\n{markdown}");
    Ok(Some(Document {
        path: relative,
        title,
        summary,
        usefulness,
        rationale,
        bytes: metadata.len(),
        modified_ns,
        headings,
        links,
        searchable_text,
    }))
}

fn parse_structure(markdown: &str) -> (Vec<Heading>, Vec<Link>) {
    let mut options = Options::empty();
    options
        .insert(Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS);
    let parser = MarkdownParser::new_ext(markdown, options);
    let mut headings = Vec::new();
    let mut links = Vec::new();
    let mut heading_level = None;
    let mut heading_text = String::new();
    let mut link_target = None;
    let mut link_label = String::new();
    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                heading_level = Some(level_number(level));
                heading_text.clear();
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = heading_level.take() {
                    let title = clean_text(&heading_text);
                    if !title.is_empty() {
                        headings.push(Heading {
                            level,
                            anchor: slug(&title),
                            title,
                        });
                    }
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                link_target = Some(dest_url.to_string());
                link_label.clear();
            }
            Event::End(TagEnd::Link) => {
                if let Some(target) = link_target.take() {
                    if !target.is_empty() {
                        links.push(Link {
                            target,
                            label: clean_text(&link_label),
                        });
                    }
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if heading_level.is_some() {
                    heading_text.push_str(&text);
                }
                if link_target.is_some() {
                    link_label.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if heading_level.is_some() {
                    heading_text.push(' ');
                }
                if link_target.is_some() {
                    link_label.push(' ');
                }
            }
            _ => {}
        }
    }
    (headings, links)
}

fn level_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn clean_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn slug(text: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            result.push(ch);
            separator = false;
        } else if (ch.is_whitespace() || ch == '-') && !separator && !result.is_empty() {
            result.push('-');
            separator = true;
        }
    }
    result.trim_matches('-').to_string()
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .replace(['-', '_'], " ")
}

fn summary_from_markdown(markdown: &str) -> String {
    markdown
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !line.starts_with("<!--")
                && !line.starts_with("```")
                && !line.starts_with('[')
        })
        .map(|line| {
            let text = clean_text(
                &line
                    .trim_start_matches('>')
                    .trim_start_matches('-')
                    .replace("**", "")
                    .replace("__", "")
                    .replace('`', ""),
            );
            let mut chars = text.chars();
            let excerpt: String = chars.by_ref().take(180).collect();
            if chars.next().is_some() {
                format!("{excerpt}…")
            } else {
                excerpt
            }
        })
        .unwrap_or_default()
}

fn usefulness_score(path: &str, body: &str, headings: &[Heading]) -> (i64, String) {
    let lower = path.to_ascii_lowercase();
    let name = Path::new(path)
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut score = 0;
    let mut signals = Vec::new();
    if matches!(
        name.as_str(),
        "readme.md"
            | "agent.md"
            | "agents.md"
            | "contributing.md"
            | "architecture.md"
            | "security.md"
            | "claude.md"
            | "copilot-instructions.md"
    ) {
        score += 8;
        signals.push("recognized project guide filename");
    }
    if lower.starts_with("docs/")
        || lower.starts_with("doc/")
        || lower.starts_with("specs/")
        || lower.starts_with(".github/")
    {
        score += 4;
        signals.push("documentation or project-policy directory");
    }
    if headings.len() >= 3 {
        score += 2;
        signals.push("structured with multiple sections");
    }
    let terms = [
        "architecture",
        "design",
        "implementation",
        "development",
        "testing",
        "build",
        "run",
        "security",
        "invariant",
        "api",
        "overview",
        "guide",
    ];
    let body_lower = body.to_ascii_lowercase();
    let matched: Vec<&str> = terms
        .iter()
        .copied()
        .filter(|term| body_lower.contains(term))
        .collect();
    if !matched.is_empty() {
        score += (matched.len().min(4)) as i64;
        signals.push("contains practical engineering topics");
    }
    (
        score,
        if signals.is_empty() {
            "".into()
        } else {
            signals.join("; ")
        },
    )
}

fn create_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
         CREATE TABLE IF NOT EXISTS documents (
           id INTEGER PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
           path TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, usefulness INTEGER NOT NULL,
           rationale TEXT NOT NULL, bytes INTEGER NOT NULL, modified_ns TEXT NOT NULL,
           UNIQUE(repository_id, path));
         CREATE TABLE IF NOT EXISTS sections (
           id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
           ordinal INTEGER NOT NULL, level INTEGER NOT NULL, title TEXT NOT NULL, anchor TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS links (
           id INTEGER PRIMARY KEY, source_document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
           target TEXT NOT NULL, label TEXT NOT NULL, resolved_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
           path UNINDEXED, document_id UNINDEXED, title, summary, section_titles, body, tokenize='porter unicode61');
         CREATE INDEX IF NOT EXISTS sections_document_idx ON sections(document_id, ordinal);
         CREATE INDEX IF NOT EXISTS links_source_idx ON links(source_document_id);"
    )?;
    Ok(())
}

fn rebuild_index(
    tx: &Transaction<'_>,
    root: &Path,
    documents: &[Document],
) -> Result<(), AppError> {
    tx.execute("INSERT INTO repositories(root) VALUES (?1) ON CONFLICT(root) DO UPDATE SET indexed_at=CURRENT_TIMESTAMP", [root.to_string_lossy().as_ref()])?;
    let repo_id: i64 = tx.query_row(
        "SELECT id FROM repositories WHERE root=?1",
        [root.to_string_lossy().as_ref()],
        |row| row.get(0),
    )?;
    tx.execute("DELETE FROM search_index WHERE document_id IN (SELECT id FROM documents WHERE repository_id=?1)", [repo_id])?;
    tx.execute("DELETE FROM documents WHERE repository_id=?1", [repo_id])?;
    insert_documents(tx, repo_id, documents)?;
    refresh_link_targets(tx, root, repo_id)?;
    Ok(())
}

fn update_dirty_paths(
    tx: &Transaction<'_>,
    root: &Path,
    dirty_paths: &[String],
    documents: &[Document],
) -> Result<(), AppError> {
    tx.execute("INSERT INTO repositories(root) VALUES (?1) ON CONFLICT(root) DO UPDATE SET indexed_at=CURRENT_TIMESTAMP", [root.to_string_lossy().as_ref()])?;
    let repo_id: i64 = tx.query_row(
        "SELECT id FROM repositories WHERE root=?1",
        [root.to_string_lossy().as_ref()],
        |row| row.get(0),
    )?;
    for path in dirty_paths {
        tx.execute(
            "DELETE FROM search_index WHERE document_id IN (SELECT id FROM documents WHERE repository_id=?1 AND path=?2)",
            params![repo_id, path],
        )?;
        tx.execute(
            "DELETE FROM documents WHERE repository_id=?1 AND path=?2",
            params![repo_id, path],
        )?;
    }
    insert_documents(tx, repo_id, documents)?;
    refresh_link_targets(tx, root, repo_id)?;
    Ok(())
}

fn insert_documents(
    tx: &Transaction<'_>,
    repo_id: i64,
    documents: &[Document],
) -> Result<(), AppError> {
    for doc in documents {
        tx.execute("INSERT INTO documents(repository_id,path,title,summary,usefulness,rationale,bytes,modified_ns) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![repo_id, doc.path, doc.title, doc.summary, doc.usefulness, doc.rationale, doc.bytes as i64, doc.modified_ns.to_string()])?;
        let doc_id = tx.last_insert_rowid();
        for (ordinal, heading) in doc.headings.iter().enumerate() {
            tx.execute("INSERT INTO sections(document_id,ordinal,level,title,anchor) VALUES (?1,?2,?3,?4,?5)", params![doc_id, ordinal as i64, heading.level, heading.title, heading.anchor])?;
        }
        let section_titles = doc
            .headings
            .iter()
            .map(|h| h.title.as_str())
            .collect::<Vec<_>>()
            .join(". ");
        tx.execute("INSERT INTO search_index(path,document_id,title,summary,section_titles,body) VALUES (?1,?2,?3,?4,?5,?6)", params![doc.path, doc_id, doc.title, doc.summary, section_titles, doc.searchable_text])?;
    }
    for doc in documents {
        let source_id: i64 = tx.query_row(
            "SELECT id FROM documents WHERE repository_id=?1 AND path=?2",
            params![repo_id, doc.path],
            |row| row.get(0),
        )?;
        for link in &doc.links {
            tx.execute(
                "INSERT INTO links(source_document_id,target,label) VALUES (?1,?2,?3)",
                params![source_id, link.target, link.label],
            )?;
        }
    }
    Ok(())
}

fn refresh_link_targets(tx: &Transaction<'_>, root: &Path, repo_id: i64) -> Result<(), AppError> {
    let mut statement = tx.prepare(
        "SELECT links.id, documents.path, links.target FROM links JOIN documents ON documents.id=links.source_document_id WHERE documents.repository_id=?1",
    )?;
    let rows = statement.query_map([repo_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut targets = Vec::new();
    for row in rows {
        targets.push(row?);
    }
    drop(statement);
    for (link_id, source, target) in targets {
        let resolved_path = resolve_link(root, &source, &target);
        let resolved_id = match resolved_path {
            Some(path) => tx
                .query_row(
                    "SELECT id FROM documents WHERE repository_id=?1 AND path=?2",
                    params![repo_id, path],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?,
            None => None,
        };
        tx.execute(
            "UPDATE links SET resolved_document_id=?1 WHERE id=?2",
            params![resolved_id, link_id],
        )?;
    }
    Ok(())
}

fn resolve_link(root: &Path, source: &str, target: &str) -> Option<String> {
    if target.starts_with('#') || target.contains("://") || target.starts_with("mailto:") {
        return None;
    }
    let target_path = target.split('#').next()?.split('?').next()?;
    if target_path.is_empty() {
        return None;
    }
    let joined = Path::new(source)
        .parent()
        .unwrap_or(Path::new(""))
        .join(target_path);
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(part) => normalized.push(part),
            _ => return None,
        }
    }
    let relative = normalized.to_string_lossy().replace('\\', "/");
    let candidates = [
        relative.clone(),
        format!("{relative}.md"),
        format!("{relative}/README.md"),
        format!("{relative}/index.md"),
    ];
    candidates
        .into_iter()
        .find(|candidate| root.join(candidate).is_file())
}

fn guidebook(conn: &Connection, root: &Path) -> Result<String, AppError> {
    let repo_id = repository_id(conn, root)?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM documents WHERE repository_id=?1",
        [repo_id],
        |row| row.get(0),
    )?;
    let mut out = format!(
        "# Project Guidebook\n\nRepository: `{}`\nUseful Markdown documents indexed: {count}\n\n",
        root.display()
    );
    if count == 0 {
        out.push_str(
            "No useful Markdown documents are indexed. Run `git-guide index .` to build the map.\n",
        );
        return Ok(out);
    }
    out.push_str("## Start here\n\n");
    let mut statement = conn.prepare("SELECT path,title,summary,rationale FROM documents WHERE repository_id=?1 ORDER BY usefulness DESC, path ASC LIMIT ?2")?;
    let rows = statement.query_map(params![repo_id, MAX_GUIDEBOOK_DOCS as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut docs = Vec::new();
    for row in rows {
        docs.push(row?);
    }
    for (path, title, summary, reason) in &docs {
        out.push_str(&format!("- **{}** — `{}`\n", title, path));
        if !summary.is_empty() {
            out.push_str(&format!("  - {summary}\n"));
        }
        if !reason.is_empty() {
            out.push_str(&format!("  - Why useful: {reason}.\n"));
        }
    }
    out.push_str("\n## Knowledge map\n\n");
    out.push_str("Each indexed document is mapped to its headings and Markdown links. Use `git-guide query <terms>` to locate a topic, then read the listed file/section directly for full details. `git-guide show <path>` lists a document's mapped sections and local references.\n\n");
    let groups: Vec<(String, i64)> = {
        let mut stmt = conn.prepare("SELECT CASE WHEN path LIKE 'docs/%' THEN 'docs/' WHEN path LIKE 'specs/%' THEN 'specs/' WHEN path LIKE '.github/%' THEN '.github/' ELSE 'root and other paths' END AS group_name, COUNT(*) FROM documents WHERE repository_id=?1 GROUP BY group_name ORDER BY COUNT(*) DESC, group_name")?;
        let rows = stmt.query_map([repo_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (group, size) in groups {
        out.push_str(&format!("- `{group}`: {size} document(s)\n"));
    }
    Ok(out)
}

fn query_guide(
    conn: &Connection,
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<String, AppError> {
    let repo_id = repository_id(conn, root)?;
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|part| {
            part.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if terms.is_empty() {
        return Err(AppError::InvalidQuery(
            "query must contain letters or numbers".into(),
        ));
    }
    let expression = terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut stmt = conn.prepare("SELECT d.path, d.title, d.summary, s.section_titles, snippet(search_index,5,'[',']',' … ',18), bm25(search_index,0.0,0.0,4.0,1.0,3.0,1.5) FROM search_index s JOIN documents d ON d.id=s.document_id WHERE d.repository_id=?1 AND search_index MATCH ?2 ORDER BY bm25(search_index,0.0,0.0,4.0,1.0,3.0,1.5) LIMIT ?3")?;
    let rows = stmt.query_map(params![repo_id, expression, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
        ))
    })?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row?);
    }
    let mut out = format!("# Guidebook: {}\n\n", clean_text(query));
    if matches.is_empty() {
        out.push_str("No indexed document matched. Try broader terms or run `git-guide index .` after adding documentation.\n");
        return Ok(out);
    }
    out.push_str("Relevant sources (open the file and section for full context):\n\n");
    for (path, title, summary, sections, snippet, _score) in matches {
        let section = sections
            .split(". ")
            .find(|section| {
                terms
                    .iter()
                    .any(|term| section.to_lowercase().contains(&term.to_lowercase()))
            })
            .unwrap_or("");
        out.push_str(&format!("- **{title}** — `{path}`"));
        if !section.is_empty() {
            out.push_str(&format!(" → {section}"));
        }
        out.push('\n');
        if !summary.is_empty() {
            out.push_str(&format!("  - Summary: {summary}\n"));
        }
        if !snippet.is_empty() {
            out.push_str(&format!("  - Match: {}\n", snippet.replace(['[', ']'], "")));
        }
    }
    out.push_str("\nRead these files directly before relying on details; this guidebook is a navigation map, not a substitute for source evidence.\n");
    Ok(out)
}

fn show_document(conn: &Connection, path: &str) -> Result<String, AppError> {
    let result: Option<(i64, String, String, String, i64)> = conn
        .query_row(
            "SELECT id,title,summary,rationale,usefulness FROM documents WHERE path=?1",
            [path],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((id, title, summary, rationale, score)) = result else {
        return Ok(format!(
            "No indexed map for `{path}`. Run `git-guide index .` or query the guidebook.\n"
        ));
    };
    let mut out = format!("# {title}\n\nPath: `{path}`\nUsefulness: {score} ({rationale})\n\n");
    if !summary.is_empty() {
        out.push_str(&format!("{summary}\n\n"));
    }
    out.push_str("## Sections\n\n");
    let mut sections = conn
        .prepare("SELECT level,title,anchor FROM sections WHERE document_id=?1 ORDER BY ordinal")?;
    for row in sections.query_map([id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (level, section, anchor) = row?;
        out.push_str(&format!(
            "{} [{section}](#{anchor})\n",
            "  ".repeat(level.saturating_sub(1) as usize)
        ));
    }
    out.push_str("\n## Local references\n\n");
    let mut links = conn.prepare("SELECT target,label,resolved_document_id FROM links WHERE source_document_id=?1 ORDER BY target")?;
    let rows = links.query_map([id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;
    let mut has_links = false;
    for row in rows {
        let (target, label, resolved) = row?;
        has_links = true;
        let suffix = resolved.map(|_| " (indexed local document)").unwrap_or("");
        out.push_str(&format!("- {label} → `{target}`{suffix}\n"));
    }
    if !has_links {
        out.push_str("No Markdown links found.\n");
    }
    Ok(out)
}

fn repository_id(conn: &Connection, root: &Path) -> Result<i64, AppError> {
    conn.query_row(
        "SELECT id FROM repositories WHERE root=?1",
        [root.to_string_lossy().as_ref()],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| {
        AppError::InvalidQuery("repository is not indexed; run `git-guide index .`".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn indexing_maps_useful_docs_and_local_markdown_links() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("README.md"), "# Project\n\nA compact Rust service.\n\n## Architecture\nUse a fast knowledge map.\n\n[Guide](docs/guide.md)\n").unwrap();
        fs::write(
            root.join("docs/guide.md"),
            "# Architecture Guide\n\n## Search\nSQLite full text search index.\n\nThe transactional map links architectural decisions to concrete implementation evidence.\n",
        )
        .unwrap();
        fs::write(root.join("random.md"), "just incidental words").unwrap();
        let db = root.join("knowledge.sqlite3");
        assert_eq!(index_repository(root, &db).unwrap().0, 2);
        assert!(open_database(root, Some(&db)).is_ok());
        let conn = Connection::open(&db).unwrap();
        let guide = guidebook(&conn, root).unwrap();
        assert!(guide.contains("README.md"));
        assert!(guide.contains("docs/guide.md"));
        let results = query_guide(&conn, root, "transactional evidence", 5).unwrap();
        assert!(results.contains("docs/guide.md"));
        let details = show_document(&conn, "README.md").unwrap();
        assert!(details.contains("Architecture"));
        assert!(details.contains("indexed local document"));
    }

    #[test]
    fn ignores_generated_and_ignored_content_and_reindex_removes_stale_rows() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(
            root.join(".gitignore"),
            ".finleet/\nignored/\nnode_modules/\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(
            root.join("README.md"),
            "# Readme\n\n## Build\nnpm build and architecture.",
        )
        .unwrap();
        fs::write(
            root.join("node_modules/pkg/README.md"),
            "# Dependency\n\n## API\n",
        )
        .unwrap();
        fs::write(root.join("ignored/guide.md"), "# Ignored\n\n## API\n").unwrap();
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(root)
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Git Guide Test",
                "-c",
                "user.email=git-guide@example.test",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            ])
            .current_dir(root)
            .status()
            .unwrap();
        let db = root.join(".finleet/knowledge.sqlite3");
        assert_eq!(index_repository(root, &db).unwrap().0, 1);
        fs::remove_file(root.join("README.md")).unwrap();
        assert_eq!(index_repository(root, &db).unwrap().0, 0);
        let conn = Connection::open(db).unwrap();
        assert!(guidebook(&conn, root)
            .unwrap()
            .contains("No useful Markdown"));
    }

    #[test]
    fn dirty_worktree_updates_only_changed_paths_and_keeps_clean_documents() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root)
            .status()
            .unwrap();
        fs::write(root.join(".gitignore"), ".finleet/\n").unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(
            root.join("README.md"),
            "# Project\n\n## Original\nThe original repository overview.\n",
        )
        .unwrap();
        fs::write(
            root.join("docs/stable.md"),
            "# Stable Guide\n\n## Reference\nThis clean guide must remain indexed.\n",
        )
        .unwrap();
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(root)
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args([
                "-c",
                "user.name=Git Guide Test",
                "-c",
                "user.email=git-guide@example.test",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            ])
            .current_dir(root)
            .status()
            .unwrap();

        let db = root.join(".finleet/knowledge.sqlite3");
        assert_eq!(index_repository(root, &db).unwrap(), (2, false, 0));
        fs::write(
            root.join("README.md"),
            "# Updated Project\n\n## Changed\nA dirty-path-only refresh.\n",
        )
        .unwrap();
        fs::remove_file(root.join("docs/stable.md")).unwrap();
        fs::write(
            root.join("docs/new.md"),
            "# New Guide\n\n## Incremental\nThis document is introduced while the worktree is dirty.\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/incremental.rs"),
            "# Not Markdown\n\nThis code source must not enter the guidebook.\n",
        )
        .unwrap();

        let summary = index_repository(root, &db).unwrap();
        assert!(summary.1);
        assert_eq!(summary.2, 3);
        let conn = Connection::open(&db).unwrap();
        let source_doc_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE path='src/incremental.rs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_doc_count, 0);
        let title: String = conn
            .query_row(
                "SELECT title FROM documents WHERE path='README.md'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Updated Project");
        let clean_guide = conn
            .query_row(
                "SELECT title FROM documents WHERE path='docs/stable.md'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap();
        assert_eq!(clean_guide, None);
        let query = query_guide(&conn, root, "clean guide remain", 5).unwrap();
        assert!(query.contains("No indexed document matched"));
        assert!(query_guide(&conn, root, "introduced document", 5)
            .unwrap()
            .contains("docs/new.md"));
    }

    #[test]
    fn parses_git_porcelain_paths_including_rename_sources() {
        let output = b" M README.md\0R  docs/new.md\0docs/old.md\0?? docs/untracked.md\0";
        assert_eq!(
            parse_git_status_paths(output),
            vec![
                "README.md",
                "docs/new.md",
                "docs/old.md",
                "docs/untracked.md"
            ]
        );
    }

    #[test]
    fn parses_headings_and_links_and_normalizes_anchor() {
        let (headings, links) = parse_structure("# Hello World\n\n[Useful guide](guide.md#part)\n");
        assert_eq!(headings[0].anchor, "hello-world");
        assert_eq!(links[0].target, "guide.md#part");
        assert_eq!(links[0].label, "Useful guide");
    }
}
