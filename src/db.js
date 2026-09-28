const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/taproom.db');
// Uploaded files (logos, tap images) live alongside the database so they
// persist on the same volume across container rebuilds.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(path.dirname(DB_PATH), 'uploads');

let db;
let SQL;

async function initSql() {
  if (!SQL) SQL = await initSqlJs();
}

let rawSqlDb; // keep reference to underlying sql.js db for export

// Persist db to disk
function persist() {
  const data = rawSqlDb.export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

async function initDb() {
  await initSql();
  let rawDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    rawDb = new SQL.Database(fileBuffer);
  } else {
    rawDb = new SQL.Database();
  }
  wrapDb(rawDb); // sets db to wrapped version
  initSchema();
  persist();
  return db;
}

// Wrap sql.js to have a similar API to better-sqlite3
function wrapDb(sqlDb) {
  rawSqlDb = sqlDb;
  const wrapped = {
    _db: sqlDb,
    exec(sql) { sqlDb.run(sql); persist(); },
    prepare(sql) {
      return {
        run(...params) {
          sqlDb.run(sql, params);
          persist();
        },
        get(...params) {
          const stmt = sqlDb.prepare(sql);
          stmt.bind(params);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...params) {
          const results = [];
          const stmt = sqlDb.prepare(sql);
          stmt.bind(params);
          while (stmt.step()) results.push(stmt.getAsObject());
          stmt.free();
          return results;
        }
      };
    },
    transaction(fn) {
      return (args) => {
        sqlDb.run('BEGIN');
        try { fn(args); sqlDb.run('COMMIT'); persist(); }
        catch(e) { sqlDb.run('ROLLBACK'); throw e; }
      };
    }
  };
  // replace db with wrapped
  db = wrapped;
  return wrapped;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS taps (
      id TEXT PRIMARY KEY,
      tap_number INTEGER,
      name TEXT NOT NULL,
      style TEXT,
      producer TEXT,
      abv REAL,
      ibu INTEGER,
      description TEXT,
      tasting_notes TEXT,
      category TEXT DEFAULT 'beer',
      status TEXT DEFAULT 'active',
      keg_level INTEGER DEFAULT 100,
      untappd_url TEXT,
      brewfather_id TEXT,
      brewers_friend_id TEXT,
      grainfather_id TEXT,
      external_source TEXT,
      external_id TEXT,
      serving_size TEXT DEFAULT '16oz',
      price TEXT,
      color TEXT,
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('taproom_name', 'Tap Menu'),
      ('brewery_name', ''),
      ('establishment_name', ''),
      ('tagline', 'What''s on tap'),
      ('display_theme', 'dark'),
      ('show_abv', '1'),
      ('show_ibu', '1'),
      ('show_price', '0'),
      ('show_keg_level', '1'),
      ('show_style', '1'),
      ('show_producer', '1'),
      ('show_category', '1'),
      ('show_serve_method', '1'),
      ('show_glassware', '1'),
      ('show_tasting_notes', '1'),
      ('show_on_tap_date', '1'),
      ('show_description', '1'),
      ('show_serving_size', '1'),
      ('pipeline_enabled', '1'),
      ('pipeline_title', 'Coming Soon'),
      ('pipeline_refresh_mins', '0'),
      ('show_qr_codes', '1'),
      ('menu_page_enabled', '1'),
      ('custom_css', ''),
      ('accent_color', '#f59e0b'),
      ('logo_url', ''),
      ('use_logo_as_brand', '0'),
      ('logo_size', '64'),
      ('display_layout', 'cards'),
      ('brewfather_api_user_id', ''),
      ('brewfather_api_key', '');
  `);
  runMigrations();
}

// Add new columns to existing databases without losing data
function runMigrations() {
  const migrations = [
    `ALTER TABLE taps ADD COLUMN tap_label TEXT`,
    `ALTER TABLE taps ADD COLUMN serve_method TEXT`,
    `ALTER TABLE taps ADD COLUMN glassware TEXT`,
    `ALTER TABLE taps ADD COLUMN on_tap_date TEXT`,
    `ALTER TABLE taps ADD COLUMN brewfather_batch_no INTEGER`,
    `ALTER TABLE taps ADD COLUMN last_synced_at DATETIME`,
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch(e) {
      // Column already exists — safe to ignore
      if (!e.message.includes('duplicate column')) {
        // truly unexpected error, log it
        console.warn('Migration warning:', e.message);
      }
    }
  }
}

module.exports = { getDb, initDb, UPLOADS_DIR };
