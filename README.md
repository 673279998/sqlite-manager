# SQLite Manager - Obsidian Plugin

View and manage SQLite databases directly in Obsidian, with special support for JSON fields displayed as nested tables.

## Features

### Data Viewing
- Automatically scans vault for `.db`, `.sqlite`, `.sqlite3` files
- Table selector dropdown to switch between tables
- **JSON fields auto-detected and rendered as nested tables** - arrays of objects are displayed as inline mini-tables (first 3 rows x 4 columns), with an "Expand" button to view the full table in a modal
- JSON objects shown as clickable buttons, click to expand detailed key-value pairs
- Column sorting (click column headers to toggle ascending/descending)
- Full-text search filtering
- Truncated long text with click-to-expand

### Data Editing
- Each row has an Edit button
- Automatic field type detection (PK, Required, Auto-increment ID)
- JSON fields automatically provide textarea editing with "Format JSON" and "Compress JSON" quick action buttons
- After editing, reminder to save the database to persist changes

### Data Deletion
- Each row has a Delete button
- Confirmation dialog before deletion, showing primary key information
- Auto-refresh data after deletion

### Add Data
- Add Record button at the top
- Auto-increment primary key fields are skipped automatically
- Required field validation hints
- JSON fields also support format/compress functionality

### Save Database
- All CRUD operations are performed in memory first
- Click Save to write changes to the disk file
- Prevents accidental data loss from unintended modifications

### Export
- Copy as JSON button to copy current filtered results to clipboard

## How to Use

1. Install and enable the plugin
2. Open SQLite Manager via:
   - Click the database icon in the left sidebar
   - Use command palette (Ctrl+P) and search for "Open SQLite Manager"
   - Click directly on a `.db` file in your vault
3. Select a table from the dropdown
4. View, edit, add, or delete records
5. Click Save to persist changes to the database file

## Settings

- **sql.js WASM Path**: Path to the sql.js WASM file. Leave empty to load from CDN. Required for offline/intranet use.
- **Preview Row Limit**: Maximum number of rows displayed when viewing a table (default: 200)

## Technical Notes

- Uses [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) for browser-based SQLite operations
- First launch requires internet connection to load sql.js from CDN (unless a local WASM path is configured)
- All database operations are performed in memory; changes must be explicitly saved
- JSON field detection works by checking if a string value starts with `[` or `{` and can be successfully parsed as JSON

## Installation

### From Obsidian Community Plugins (recommended)
1. Open Settings - Community Plugins
2. Disable Safe Mode
3. Click Browse and search for "SQLite Manager"
4. Install and enable

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder named `sqlite-manager` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into that folder
4. Enable the plugin in Obsidian Settings - Community Plugins

## Changelog

### v1.0.1 (2026-11-06)
- **Fix**: Compatible with Obsidian 1.15.0 (base classes migrated to ES6 classes; plugin rebuilt with native `class` inheritance)
- **Fix**: Removed duplicate file extension registration to avoid conflicts with other SQLite plugins (e.g. sqlite-explorer)
- **Fix**: Inline editable JSON table for arrays of objects when editing rows; plain inputs when adding rows
- **Fix**: Horizontal column headers in JSON table editor

### v1.0.0 (2026-06-02)
- Initial release

## License

MIT License
