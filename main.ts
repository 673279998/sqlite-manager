import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	Modal,
	FuzzySuggestModal,
	ItemView,
} from "obsidian";

import initSqlJs, { Database } from "sql.js";

// ============================================================
// Types
// ============================================================

interface SqliteManagerSettings {
	wasmPath: string;
	previewLimit: number;
}

const DEFAULT_SETTINGS: SqliteManagerSettings = {
	wasmPath: "",
	previewLimit: 200,
};

interface ColumnInfo {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	dflt_value: string | null;
}

interface TableData {
	columns: ColumnInfo[];
	rows: Record<string, any>[];
}

// ============================================================
// SQL.js Helpers
// ============================================================

let SQL: any = null;

async function getSqlJs(wasmPath: string): Promise<any> {
	if (SQL) return SQL;
	if (wasmPath) {
		SQL = await initSqlJs({ locateFile: () => wasmPath });
	} else {
		SQL = await initSqlJs({
			locateFile: (file: string) =>
				`https://sql.js.org/dist/${file}`,
		});
	}
	return SQL;
}

function openDatabase(SQL: any, buffer: ArrayBuffer): Database {
	return new SQL.Database(new Uint8Array(buffer));
}

function getTables(db: Database): string[] {
	const result = db.exec(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
	);
	if (!result.length) return [];
	return result[0].values.map((v) => v[0] as string);
}

function getColumns(db: Database, table: string): ColumnInfo[] {
	const result = db.exec(`PRAGMA table_info("${table}")`);
	if (!result.length) return [];
	return result[0].values.map((v) => ({
		name: v[1] as string,
		type: (v[2] as string) || "",
		notnull: v[3] as number,
		dflt_value: v[4] as string | null,
		pk: v[5] as number,
	}));
}

function getTableData(
	db: Database,
	table: string,
	limit: number
): TableData {
	const columns = getColumns(db, table);
	const result = db.exec(`SELECT * FROM "${table}" LIMIT ${limit}`);
	const rows: Record<string, any>[] = [];
	if (result.length) {
		const colNames = result[0].columns;
		for (const valueRow of result[0].values) {
			const row: Record<string, any> = {};
			colNames.forEach((col, i) => {
				row[col] = valueRow[i];
			});
			rows.push(row);
		}
	}
	return { columns, rows };
}

function getRowCount(db: Database, table: string): number {
	const result = db.exec(`SELECT COUNT(*) FROM "${table}"`);
	if (!result.length) return 0;
	return result[0].values[0][0] as number;
}

// Try to parse a string as JSON
function tryParseJson(value: any): any {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (
		!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
		!(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return null;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

// Check if a value is an array of objects (table-like JSON)
function isTableLikeJson(parsed: any): boolean {
	if (!Array.isArray(parsed)) return false;
	if (parsed.length === 0) return false;
	return typeof parsed[0] === "object" && parsed[0] !== null;
}

// Escape HTML
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ============================================================
// DB File Picker Modal
// ============================================================

class DbFileSuggestModal extends FuzzySuggestModal<string> {
	private resolve: (value: string) => void;
	private dbFiles: string[];

	constructor(app: App, dbFiles: string[], resolve: (value: string) => void) {
		super(app);
		this.dbFiles = dbFiles;
		this.resolve = resolve;
		this.setPlaceholder("选择一个数据库文件...");
		this.emptyStateText = "没有找到数据库文件";
	}

	getItems(): string[] {
		return this.dbFiles;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, _evt: MouseEvent | KeyboardEvent): void {
		this.resolve(item);
	}

	onClose(): void {
		// If nothing was selected, resolve with empty string
	}
}

// ============================================================
// Edit Row Modal
// ============================================================

class EditRowModal extends Modal {
	private columns: ColumnInfo[];
	private rowData: Record<string, any>;
	private onSave: (data: Record<string, any>) => void;
	private isEdit: boolean;

	constructor(
		app: App,
		columns: ColumnInfo[],
		rowData: Record<string, any>,
		onSave: (data: Record<string, any>) => void,
		isEdit: boolean = true
	) {
		super(app);
		this.columns = columns;
		this.rowData = { ...rowData };
		this.onSave = onSave;
		this.isEdit = isEdit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sqlite-manager-modal");

		const title = this.isEdit ? "编辑记录" : "新增记录";
		contentEl.createEl("h2", { text: title });

		const form = contentEl.createDiv({ cls: "sqlite-manager-form" });

		for (const col of this.columns) {
			const isAutoIncrement =
				col.pk === 1 && col.type.toUpperCase() === "INTEGER";
			// Skip auto-increment primary key when editing
			if (this.isEdit && isAutoIncrement) continue;

			const fieldDiv = form.createDiv({
				cls: "sqlite-manager-form-field",
			});

			const label = fieldDiv.createEl("label", {
				cls: "sqlite-manager-form-label",
			});
			label.textContent = col.name;
			if (col.pk === 1) {
				label.createSpan({
					cls: "sqlite-manager-badge pk",
					text: "PK",
				});
			}
			if (col.notnull && !isAutoIncrement) {
				label.createSpan({
					cls: "sqlite-manager-badge required",
					text: "必填",
				});
			}
			const typeHint = label.createSpan({
				cls: "sqlite-manager-type-hint",
			});
			typeHint.textContent = col.type || "TEXT";

			const value = this.rowData[col.name];

			// Check if this looks like a JSON field
			const isJsonField =
				typeof value === "string" &&
				(value.trim().startsWith("[") || value.trim().startsWith("{"));

			if (isJsonField) {
				const textarea = fieldDiv.createEl("textarea", {
					cls: "sqlite-manager-form-input json-input",
					attr: {
						placeholder: `输入JSON格式的${col.name}`,
						rows: "6",
						spellcheck: "false",
					},
				});
				textarea.value =
					typeof value === "string"
						? value
						: JSON.stringify(value, null, 2);

				// JSON format button
				const btnGroup = fieldDiv.createDiv({
					cls: "sqlite-manager-form-btn-group",
				});
				const formatBtn = btnGroup.createEl("button", {
					text: "格式化JSON",
					cls: "mod-muted",
				});
				formatBtn.addEventListener("click", () => {
					try {
						const parsed = JSON.parse(textarea.value);
						textarea.value = JSON.stringify(parsed, null, 2);
					} catch {
						new Notice("JSON格式不正确，无法格式化");
					}
				});
				const compressBtn = btnGroup.createEl("button", {
					text: "压缩JSON",
					cls: "mod-muted",
				});
				compressBtn.addEventListener("click", () => {
					try {
						const parsed = JSON.parse(textarea.value);
						textarea.value = JSON.stringify(parsed);
					} catch {
						new Notice("JSON格式不正确，无法压缩");
					}
				});

				textarea.addEventListener("change", () => {
					this.rowData[col.name] = textarea.value || null;
				});
			} else {
				const input = fieldDiv.createEl("input", {
					cls: "sqlite-manager-form-input",
					attr: {
						type: "text",
						placeholder: isAutoIncrement
							? "自动生成"
							: `输入${col.name}`,
						spellcheck: "false",
					},
				});
				input.value = value !== null && value !== undefined ? String(value) : "";
				if (isAutoIncrement) {
					input.disabled = true;
				}
				input.addEventListener("change", () => {
					this.rowData[col.name] = input.value || null;
				});
			}
		}

		// Buttons
		const btnDiv = contentEl.createDiv({
			cls: "sqlite-manager-form-actions",
		});
		const saveBtn = btnDiv.createEl("button", {
			text: "保存",
			cls: "mod-cta",
		});
		saveBtn.addEventListener("click", (e) => {
			e.preventDefault();
			this.onSave(this.rowData);
			this.close();
		});
		const cancelBtn = btnDiv.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============================================================
// Confirm Delete Modal
// ============================================================

class ConfirmDeleteModal extends Modal {
	private onConfirm: () => void;
	private message: string;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sqlite-manager-modal");

		contentEl.createEl("h2", { text: "确认删除" });
		contentEl.createEl("p", {
			text: this.message,
			cls: "sqlite-manager-confirm-text",
		});

		const btnDiv = contentEl.createDiv({
			cls: "sqlite-manager-form-actions",
		});
		const deleteBtn = btnDiv.createEl("button", {
			text: "删除",
			cls: "mod-warning",
		});
		deleteBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
		const cancelBtn = btnDiv.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============================================================
// JSON Detail View Modal
// ============================================================

class JsonDetailModal extends Modal {
	private jsonData: any;
	private fieldName: string;

	constructor(app: App, fieldName: string, jsonData: any) {
		super(app);
		this.fieldName = fieldName;
		this.jsonData = jsonData;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("sqlite-manager-modal");
		contentEl.addClass("sqlite-manager-json-modal");

		contentEl.createEl("h2", { text: `${this.fieldName} - 详细视图` });

		if (isTableLikeJson(this.jsonData)) {
			this.renderTableLikeJson(contentEl, this.jsonData);
		} else if (typeof this.jsonData === "object" && this.jsonData !== null) {
			this.renderObjectJson(contentEl, this.jsonData);
		} else {
			contentEl.createEl("pre", {
				text: JSON.stringify(this.jsonData, null, 2),
				cls: "sqlite-manager-json-pre",
			});
		}

		const btnDiv = contentEl.createDiv({
			cls: "sqlite-manager-form-actions",
		});
		const closeBtn = btnDiv.createEl("button", { text: "关闭" });
		closeBtn.addEventListener("click", () => this.close());
	}

	renderTableLikeJson(container: HTMLElement, data: any[]) {
		if (data.length === 0) {
			container.createEl("p", { text: "（空数组）" });
			return;
		}

		// Get all unique keys from all objects
		const keys = new Set<string>();
		for (const item of data) {
			if (typeof item === "object" && item !== null) {
				Object.keys(item).forEach((k) => keys.add(k));
			}
		}
		const columns = Array.from(keys);

		const wrap = container.createDiv({
			cls: "sqlite-manager-json-table-wrap",
		});
		const table = wrap.createEl("table", {
			cls: "sqlite-manager-json-table",
		});

		// Header
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		headerRow.createEl("th", { text: "#" });
		for (const col of columns) {
			headerRow.createEl("th", { text: col });
		}

		// Body
		const tbody = table.createEl("tbody");
		for (let i = 0; i < data.length; i++) {
			const row = data[i];
			const tr = tbody.createEl("tr");
			tr.createEl("td", {
				cls: "sqlite-manager-row-num",
				text: String(i + 1),
			});
			for (const col of columns) {
				const td = tr.createEl("td");
				const val = row[col];
				if (val === null || val === undefined) {
					td.createSpan({ cls: "sqlite-manager-null", text: "NULL" });
				} else if (typeof val === "object") {
					const nested = tryParseJson(val);
					if (nested) {
						const btn = td.createEl("button", {
							cls: "sqlite-manager-json-expand-btn",
							text: "📋 查看JSON",
						});
						btn.addEventListener("click", () => {
							new JsonDetailModal(this.app, `${col}[${i}]`, nested).open();
						});
					} else {
						td.textContent = JSON.stringify(val);
					}
				} else {
					td.textContent = String(val);
				}
			}
		}

		// Summary
		container.createEl("div", {
			cls: "sqlite-manager-json-summary",
			text: `共 ${data.length} 条记录`,
		});
	}

	renderObjectJson(container: HTMLElement, data: Record<string, any>) {
		const wrap = container.createDiv({
			cls: "sqlite-manager-json-kv-wrap",
		});
		for (const [key, value] of Object.entries(data)) {
			const row = wrap.createDiv({ cls: "sqlite-manager-json-kv-row" });
			row.createEl("span", {
				cls: "sqlite-manager-json-kv-key",
				text: key,
			});
			const valSpan = row.createEl("span", {
				cls: "sqlite-manager-json-kv-value",
			});
			if (value === null || value === undefined) {
				valSpan.createSpan({
					cls: "sqlite-manager-null",
					text: "NULL",
				});
			} else if (typeof value === "object") {
				const nested = tryParseJson(value);
				if (nested) {
					const btn = valSpan.createEl("button", {
						cls: "sqlite-manager-json-expand-btn",
						text: "📋 查看JSON",
					});
					btn.addEventListener("click", () => {
						new JsonDetailModal(this.app, key, nested).open();
					});
				} else {
					valSpan.textContent = JSON.stringify(value);
				}
			} else {
				valSpan.textContent = String(value);
			}
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

// ============================================================
// SQLite Manager View
// ============================================================

const VIEW_TYPE_SQLITE_MANAGER = "sqlite-manager-view";

class SqliteManagerView extends ItemView {
	private plugin: SqliteManagerPlugin;
	private db: Database | null = null;
	private currentFile: string | null = null;
	private currentTable: string | null = null;
	private currentData: TableData | null = null;
	private sortColumn: string | null = null;
	private sortDirection: "asc" | "desc" = "asc";
	private searchQuery: string = "";

	constructor(leaf: WorkspaceLeaf, plugin: SqliteManagerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SQLITE_MANAGER;
	}

	getDisplayText(): string {
		return this.currentFile
			? `SQLite: ${this.currentFile}`
			: "SQLite Manager";
	}

	getIcon(): string {
		return "database";
	}

	async onOpen() {
		this.renderView();
	}

	async onClose() {
		this.closeDatabase();
	}

	closeDatabase() {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.currentFile = null;
		this.currentTable = null;
		this.currentData = null;
	}

	async openDbFile(filePath: string) {
		this.closeDatabase();

		try {
			const SQL = await getSqlJs(this.plugin.settings.wasmPath);
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) {
				new Notice(`找不到文件: ${filePath}`);
				return;
			}
			const buffer = await this.app.vault.readBinary(file);
			this.db = openDatabase(SQL, buffer);
			this.currentFile = filePath;
			this.currentTable = null;
			this.currentData = null;
			this.renderView();
		} catch (err) {
			new Notice(`打开数据库失败: ${err.message}`);
			console.error("打开数据库失败:", err);
		}
	}

	renderView() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("sqlite-manager");

		// Toolbar
		this.renderToolbar(container);

		if (!this.db) {
			this.renderEmptyState(container);
			return;
		}

		// Table selector and data
		this.renderTableSelector(container);

		if (this.currentTable && this.currentData) {
			this.renderDataTable(container);
		}
	}

	renderToolbar(container: HTMLElement) {
		const toolbar = container.createDiv({ cls: "sqlite-manager-toolbar" });

		// File name or placeholder
		const fileLabel = toolbar.createDiv({
			cls: "sqlite-manager-file-label",
		});
		if (this.currentFile) {
			fileLabel.textContent = `📁 ${this.currentFile}`;
		} else {
			fileLabel.textContent = "未打开数据库";
		}

		// Button group
		const btnGroup = toolbar.createDiv({
			cls: "sqlite-manager-toolbar-btns",
		});

		const openBtn = btnGroup.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "打开数据库文件" },
		});
		openBtn.innerHTML = "📂 打开";
		openBtn.addEventListener("click", () => this.pickDbFile());

		if (this.db) {
			const refreshBtn = btnGroup.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "刷新数据" },
			});
			refreshBtn.innerHTML = "🔄 刷新";
			refreshBtn.addEventListener("click", () => this.refreshData());

			const saveBtn = btnGroup.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "保存数据库" },
			});
			saveBtn.innerHTML = "💾 保存";
			saveBtn.addEventListener("click", () => this.saveDatabase());
		}
	}

	renderEmptyState(container: HTMLElement) {
		const empty = container.createDiv({
			cls: "sqlite-manager-empty",
		});
		empty.createEl("div", {
			cls: "sqlite-manager-empty-icon",
			text: "🗄️",
		});
		empty.createEl("h3", { text: "SQLite Manager" });
		empty.createEl("p", {
			text: "点击「打开」按钮选择一个 .db 文件，或使用命令面板打开数据库。",
		});

		const openBtn = empty.createEl("button", {
			text: "📂 打开数据库文件",
			cls: "mod-cta",
		});
		openBtn.addEventListener("click", () => this.pickDbFile());
	}

	renderTableSelector(container: HTMLElement) {
		const selector = container.createDiv({
			cls: "sqlite-manager-table-selector",
		});

		const tables = getTables(this.db!);

		// Table dropdown
		const dropdownWrap = selector.createDiv({
			cls: "sqlite-manager-dropdown-wrap",
		});
		dropdownWrap.createEl("span", {
			cls: "sqlite-manager-selector-label",
			text: "表:",
		});
		const dropdown = dropdownWrap.createEl("select", {
			cls: "sqlite-manager-dropdown",
		});
		dropdown.createEl("option", {
			text: "-- 选择表 --",
			attr: { value: "" },
		});
		for (const table of tables) {
			const opt = dropdown.createEl("option", {
				text: table,
				attr: { value: table },
			});
			if (table === this.currentTable) {
				(opt as HTMLOptionElement).selected = true;
			}
		}
		dropdown.addEventListener("change", () => {
			const val = (dropdown as HTMLSelectElement).value;
			if (val) {
				this.selectTable(val);
			}
		});

		// Search
		const searchWrap = selector.createDiv({
			cls: "sqlite-manager-search-wrap",
		});
		const searchInput = searchWrap.createEl("input", {
			cls: "sqlite-manager-search-input",
			attr: {
				type: "text",
				placeholder: "🔍 搜索数据...",
				value: this.searchQuery,
			},
		});
		searchInput.addEventListener("input", () => {
			this.searchQuery = (searchInput as HTMLInputElement).value;
			if (this.currentTable) {
				this.renderView();
			}
		});

		// Row count
		if (this.currentTable) {
			const count = getRowCount(this.db!, this.currentTable);
			selector.createDiv({
				cls: "sqlite-manager-row-count",
				text: `共 ${count} 行`,
			});
		}
	}

	selectTable(tableName: string) {
		this.currentTable = tableName;
		this.sortColumn = null;
		this.sortDirection = "asc";
		this.searchQuery = "";
		this.currentData = getTableData(
			this.db!,
			tableName,
			this.plugin.settings.previewLimit
		);
		this.renderView();
	}

	refreshData() {
		if (this.currentFile) {
			this.openDbFile(this.currentFile).then(() => {
				if (this.currentTable) {
					this.selectTable(this.currentTable);
				}
			});
		}
	}

	renderDataTable(container: HTMLElement) {
		if (!this.currentData || !this.currentTable) return;

		let rows = [...this.currentData.rows];

		// Search filter
		if (this.searchQuery) {
			const query = this.searchQuery.toLowerCase();
			rows = rows.filter((row) =>
				Object.values(row).some((v) =>
					String(v).toLowerCase().includes(query)
				)
			);
		}

		// Sort
		if (this.sortColumn) {
			rows.sort((a, b) => {
				const va = a[this.sortColumn!];
				const vb = b[this.sortColumn!];
				if (va === null || va === undefined) return 1;
				if (vb === null || vb === undefined) return -1;
				const cmp =
					typeof va === "number" && typeof vb === "number"
						? va - vb
						: String(va).localeCompare(String(vb));
				return this.sortDirection === "asc" ? cmp : -cmp;
			});
		}

		// Action buttons
		const actionsBar = container.createDiv({
			cls: "sqlite-manager-actions",
		});
		const addBtn = actionsBar.createEl("button", {
			cls: "sqlite-manager-btn sqlite-manager-btn-add",
			text: "➕ 新增记录",
		});
		addBtn.addEventListener("click", () => this.addRow());

		const exportBtn = actionsBar.createEl("button", {
			cls: "sqlite-manager-btn sqlite-manager-btn-export",
			text: "📋 复制为JSON",
		});
		exportBtn.addEventListener("click", () => this.copyAsJson(rows));

		// Table
		const tableWrap = container.createDiv({
			cls: "sqlite-manager-table-wrap",
		});
		const table = tableWrap.createEl("table", {
			cls: "sqlite-manager-table",
		});

		// Header
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		headerRow.createEl("th", { text: "操作", cls: "sqlite-manager-th-actions" });
		for (const col of this.currentData.columns) {
			const th = headerRow.createEl("th", {
				cls: "sqlite-manager-th-sortable",
			});

			const thWrap = th.createDiv({ cls: "sqlite-manager-th-wrap" });
			const labelDiv = thWrap.createDiv({
				cls: "sqlite-manager-th-labels",
			});
			labelDiv.createDiv({
				cls: "sqlite-manager-th-label",
				text: col.name,
			});
			labelDiv.createDiv({
				cls: "sqlite-manager-th-type",
				text: col.type || "TEXT",
			});

			if (this.sortColumn === col.name) {
				thWrap.createDiv({
					cls: `sqlite-manager-sort-icon active ${this.sortDirection}`,
					text: this.sortDirection === "asc" ? "▲" : "▼",
				});
			}

			th.addEventListener("click", () => {
				if (this.sortColumn === col.name) {
					this.sortDirection =
						this.sortDirection === "asc" ? "desc" : "asc";
				} else {
					this.sortColumn = col.name;
					this.sortDirection = "asc";
				}
				this.renderView();
			});
		}

		// Body
		const tbody = table.createEl("tbody");
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const tr = tbody.createEl("tr");

			// Action column
			const actionTd = tr.createEl("td", {
				cls: "sqlite-manager-td-actions",
			});
			const editBtn = actionTd.createEl("button", {
				cls: "sqlite-manager-row-btn edit",
				text: "✏️",
				attr: { title: "编辑" },
			});
			editBtn.addEventListener("click", () => this.editRow(row));
			const deleteBtn = actionTd.createEl("button", {
				cls: "sqlite-manager-row-btn delete",
				text: "🗑️",
				attr: { title: "删除" },
			});
			deleteBtn.addEventListener("click", () => this.deleteRow(row));

			// Data columns
			for (const col of this.currentData.columns) {
				const td = tr.createEl("td");
				const value = row[col.name];

				if (value === null || value === undefined) {
					td.createSpan({
						cls: "sqlite-manager-null",
						text: "NULL",
					});
				} else {
					const parsed = tryParseJson(value);
					if (parsed !== null && isTableLikeJson(parsed)) {
						// JSON array of objects - render as mini table
						this.renderInlineJsonTable(td, col.name, parsed);
					} else if (parsed !== null && typeof parsed === "object") {
						// JSON object - show expand button
						const btn = td.createEl("button", {
							cls: "sqlite-manager-json-btn",
							text: `📋 {${Object.keys(parsed).length}项}`,
						});
						btn.addEventListener("click", () => {
							new JsonDetailModal(
								this.app,
								col.name,
								parsed
							).open();
						});
					} else if (
						parsed !== null &&
						Array.isArray(parsed) &&
						parsed.length === 0
					) {
						td.createSpan({
							cls: "sqlite-manager-empty-array",
							text: "[]",
						});
					} else if (
						parsed !== null &&
						Array.isArray(parsed) &&
						typeof parsed[0] !== "object"
					) {
						// Simple array
						td.textContent = parsed.join(", ");
						td.addClass("sqlite-manager-cell-array");
					} else {
						const strVal = String(value);
						if (strVal.length > 50) {
							td.textContent = strVal.substring(0, 50) + "...";
							td.addClass("sqlite-manager-cell-truncated");
							td.addEventListener("click", () => {
								new Notice(strVal, 5000);
							});
						} else {
							td.textContent = strVal;
						}

						// Highlight numbers
						if (typeof value === "number") {
							td.addClass("sqlite-manager-cell-num");
						}
					}
				}
			}
		}

		// No data state
		if (rows.length === 0) {
			const emptyRow = tbody.createEl("tr");
			const emptyCell = emptyRow.createEl("td", {
				cls: "sqlite-manager-no-data",
				attr: { colspan: String(this.currentData.columns.length + 1) },
			});
			emptyCell.textContent =
				this.searchQuery || this.searchQuery.length > 0
					? "没有匹配的数据"
					: "表中暂无数据";
		}
	}

	renderInlineJsonTable(
		td: HTMLElement,
		fieldName: string,
		data: any[]
	) {
		const wrapper = td.createDiv({
			cls: "sqlite-manager-inline-json",
		});

		// Header with count and expand button
		const header = wrapper.createDiv({
			cls: "sqlite-manager-inline-json-header",
		});
		header.createSpan({
			text: `${data.length}条`,
			cls: "sqlite-manager-inline-json-count",
		});
		const expandBtn = header.createEl("button", {
			cls: "sqlite-manager-inline-json-expand",
			text: "展开",
		});
		expandBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			new JsonDetailModal(this.app, fieldName, data).open();
		});

		// Mini table (show first 3 rows, max 4 columns)
		if (data.length > 0 && typeof data[0] === "object") {
			const allKeys = new Set<string>();
			for (const item of data) {
				Object.keys(item).forEach((k) => allKeys.add(k));
			}
			const keys = Array.from(allKeys).slice(0, 4);
			const showRows = data.slice(0, 3);

			const miniTable = wrapper.createEl("table", {
				cls: "sqlite-manager-mini-table",
			});

			const thead = miniTable.createEl("thead");
			const headerRow = thead.createEl("tr");
			for (const key of keys) {
				headerRow.createEl("th", { text: key });
			}

			const tbody = miniTable.createEl("tbody");
			for (const item of showRows) {
				const row = tbody.createEl("tr");
				for (const key of keys) {
					const cell = row.createEl("td");
					const val = item[key];
					if (val === null || val === undefined) {
						cell.createSpan({
							cls: "sqlite-manager-null",
							text: "-",
						});
					} else {
						cell.textContent =
							String(val).length > 15
								? String(val).substring(0, 15) + "..."
								: String(val);
					}
				}
			}

			if (data.length > 3) {
				const moreRow = tbody.createEl("tr", {
					cls: "sqlite-manager-more-row",
				});
				const moreCell = moreRow.createEl("td", {
					attr: { colspan: String(keys.length) },
				});
				moreCell.textContent = `还有 ${data.length - 3} 条...`;
			}
		}
	}

	// ============================================================
	// CRUD Operations
	// ============================================================

	async saveDatabase() {
		if (!this.db || !this.currentFile) {
			new Notice("没有打开的数据库");
			return;
		}

		try {
			const data = this.db.export();
			const buffer = Buffer.from(data);
			const file = this.app.vault.getAbstractFileByPath(this.currentFile);
			if (file && file instanceof TFile) {
				await this.app.vault.modifyBinary(file, buffer);
				new Notice("数据库已保存");
			}
		} catch (err) {
			new Notice(`保存失败: ${err.message}`);
			console.error("保存失败:", err);
		}
	}

	editRow(row: Record<string, any>) {
		if (!this.db || !this.currentTable || !this.currentData) return;

		const modal = new EditRowModal(
			this.app,
			this.currentData.columns,
			row,
			async (newData) => {
				try {
					// Build UPDATE statement
					const pkColumns = this.currentData!.columns.filter(
						(c) => c.pk === 1
					);
					const setClauses: string[] = [];
					const values: any[] = [];

					for (const col of this.currentData!.columns) {
						if (col.pk === 1) continue; // Skip PK in SET
						setClauses.push(`"${col.name}" = ?`);
						values.push(
							this.prepareValue(newData[col.name], col)
						);
					}

					const whereClauses = pkColumns.map((col) => {
						return `"${col.name}" = ?`;
					});
					const whereValues = pkColumns.map((col) => row[col.name]);

					const sql = `UPDATE "${this.currentTable}" SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
					const stmt = this.db!.prepare(sql);
					stmt.bind([...values, ...whereValues]);
					stmt.step();
					stmt.free();

					new Notice("记录已更新（请保存数据库以持久化更改）");
					this.currentData = getTableData(
						this.db!,
						this.currentTable!,
						this.plugin.settings.previewLimit
					);
					this.renderView();
				} catch (err) {
					new Notice(`更新失败: ${err.message}`);
					console.error("更新失败:", err);
				}
			},
			true
		);
		modal.open();
	}

	deleteRow(row: Record<string, any>) {
		if (!this.db || !this.currentTable || !this.currentData) return;

		const pkColumns = this.currentData.columns.filter((c) => c.pk === 1);
		const pkValues = pkColumns
			.map((col) => `${col.name}=${row[col.name]}`)
			.join(", ");

		const modal = new ConfirmDeleteModal(
			this.app,
			`确定要删除这条记录吗？\n${pkValues}`,
			() => {
				try {
					const whereClauses = pkColumns.map(
						(col) => `"${col.name}" = ?`
					);
					const whereValues = pkColumns.map((col) => row[col.name]);

					const sql = `DELETE FROM "${this.currentTable}" WHERE ${whereClauses.join(" AND ")}`;
					const stmt = this.db!.prepare(sql);
					stmt.bind(whereValues);
					stmt.step();
					stmt.free();

					new Notice("记录已删除（请保存数据库以持久化更改）");
					this.currentData = getTableData(
						this.db!,
						this.currentTable!,
						this.plugin.settings.previewLimit
					);
					this.renderView();
				} catch (err) {
					new Notice(`删除失败: ${err.message}`);
					console.error("删除失败:", err);
				}
			}
		);
		modal.open();
	}

	addRow() {
		if (!this.db || !this.currentTable || !this.currentData) return;

		const emptyRow: Record<string, any> = {};
		for (const col of this.currentData.columns) {
			const isAutoIncrement =
				col.pk === 1 && col.type.toUpperCase() === "INTEGER";
			emptyRow[col.name] = isAutoIncrement ? null : col.dflt_value || null;
		}

		const modal = new EditRowModal(
			this.app,
			this.currentData.columns,
			emptyRow,
			(newData) => {
				try {
					const insertColumns: string[] = [];
					const insertValues: any[] = [];
					const placeholders: string[] = [];

					for (const col of this.currentData!.columns) {
						const isAutoIncrement =
							col.pk === 1 &&
							col.type.toUpperCase() === "INTEGER";
						if (isAutoIncrement && newData[col.name] === null) {
							continue; // Skip auto-increment PK
						}
						if (
							newData[col.name] === null ||
							newData[col.name] === undefined ||
							newData[col.name] === ""
						) {
							if (col.notnull && col.dflt_value === null) {
								new Notice(`${col.name} 不能为空`);
								return;
							}
							if (!col.notnull) {
								insertColumns.push(`"${col.name}"`);
								placeholders.push("NULL");
								continue;
							}
						}
						insertColumns.push(`"${col.name}"`);
						placeholders.push("?");
						insertValues.push(
							this.prepareValue(newData[col.name], col)
						);
					}

					const sql = `INSERT INTO "${this.currentTable}" (${insertColumns.join(", ")}) VALUES (${placeholders.join(", ")})`;
					const stmt = this.db!.prepare(sql);
					stmt.bind(insertValues);
					stmt.step();
					stmt.free();

					new Notice("记录已添加（请保存数据库以持久化更改）");
					this.currentData = getTableData(
						this.db!,
						this.currentTable!,
						this.plugin.settings.previewLimit
					);
					this.renderView();
				} catch (err) {
					new Notice(`新增失败: ${err.message}`);
					console.error("新增失败:", err);
				}
			},
			false
		);
		modal.open();
	}

	prepareValue(value: any, col: ColumnInfo): any {
		if (value === null || value === undefined || value === "") return null;

		const type = col.type.toUpperCase();
		if (type === "INTEGER") {
			const num = parseInt(value, 10);
			return isNaN(num) ? null : num;
		}
		if (type === "REAL" || type === "FLOAT" || type === "DOUBLE") {
			const num = parseFloat(value);
			return isNaN(num) ? null : num;
		}
		return String(value);
	}

	copyAsJson(rows: Record<string, any>[]) {
		const json = JSON.stringify(rows, null, 2);
		navigator.clipboard.writeText(json).then(() => {
			new Notice("已复制到剪贴板");
		});
	}

	async pickDbFile() {
		const dbFiles = this.findDbFiles();
		if (dbFiles.length === 0) {
			new Notice("未找到 .db 文件");
			return;
		}

		if (dbFiles.length === 1) {
			this.openDbFile(dbFiles[0]);
			return;
		}

		const modal = new DbFileSuggestModal(
			this.app,
			dbFiles,
			(filePath: string) => {
				if (filePath) {
					this.openDbFile(filePath);
				}
			}
		);
		modal.open();
	}

	findDbFiles(): string[] {
		const files = this.app.vault.getFiles();
		return files
			.filter(
				(f) =>
					f.extension === "db" ||
					f.extension === "sqlite" ||
					f.extension === "sqlite3"
			)
			.map((f) => f.path)
			.sort();
	}
}

// ============================================================
// Main Plugin Class
// ============================================================

export default class SqliteManagerPlugin extends Plugin {
	settings: SqliteManagerSettings = DEFAULT_SETTINGS;
	private view: SqliteManagerView | null = null;

	async onload() {
		await this.loadSettings();

		// Register view
		this.registerView(VIEW_TYPE_SQLITE_MANAGER, (leaf) => {
			this.view = new SqliteManagerView(leaf, this);
			return this.view;
		});

		// Ribbon icon
		this.addRibbonIcon("database", "打开 SQLite Manager", () => {
			this.activateView();
		});

		// Commands
		this.addCommand({
			id: "open-sqlite-manager",
			name: "打开 SQLite Manager",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "open-database-file",
			name: "打开数据库文件",
			callback: () => {
				this.activateView().then(() => {
					if (this.view) {
						this.view.pickDbFile();
					}
				});
			},
		});

		// Settings tab
		this.addSettingTab(new SqliteManagerSettingTab(this.app, this));

		// File extension support - open .db files with this plugin
		this.registerExtensions(["db", "sqlite", "sqlite3"], VIEW_TYPE_SQLITE_MANAGER);
	}

	onunload() {
		if (this.view) {
			this.view.closeDatabase();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_SQLITE_MANAGER);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_SQLITE_MANAGER,
					active: true,
				});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}

// ============================================================
// Settings Tab
// ============================================================

class SqliteManagerSettingTab extends PluginSettingTab {
	plugin: SqliteManagerPlugin;

	constructor(app: App, plugin: SqliteManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "SQLite Manager 设置" });

		new Setting(containerEl)
			.setName("sql.js WASM 路径")
			.setDesc(
				"sql.js 的 WASM 文件路径。留空则从 CDN 加载。可以填入本地路径如：https://sql.js.org/dist/sql-wasm.wasm"
			)
			.addText((text) =>
				text
					.setPlaceholder("留空使用CDN")
					.setValue(this.plugin.settings.wasmPath)
					.onChange(async (value) => {
						this.plugin.settings.wasmPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("预览行数限制")
			.setDesc("查看表数据时的最大行数")
			.addSlider((slider) =>
				slider
					.setLimits(10, 1000, 10)
					.setValue(this.plugin.settings.previewLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.previewLimit = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
