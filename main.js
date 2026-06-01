/*
SQLite Manager - Obsidian Plugin
View and manage SQLite databases with JSON field support
*/
"use strict";

var obsidian = require("obsidian");

// ============================================================
// __extends helper (must be before class definitions)
// ============================================================

var __extends = function(d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};

// ============================================================
// SQL.js dynamic loader
// ============================================================

var SQL_MODULE = null;

function getSqlJs(wasmPath) {
    if (SQL_MODULE) return Promise.resolve(SQL_MODULE);
    
    var sqlJsUrl = "https://sql.js.org/dist/sql-wasm.js";
    
    return new Promise(function(resolve, reject) {
        if (typeof window.initSqlJs === "function") {
            var locateFile = wasmPath
                ? function() { return wasmPath; }
                : function(file) { return "https://sql.js.org/dist/" + file; };
            window.initSqlJs({ locateFile: locateFile }).then(function(SQL) {
                SQL_MODULE = SQL;
                resolve(SQL);
            }).catch(reject);
            return;
        }
        
        var script = document.createElement("script");
        script.src = sqlJsUrl;
        script.onload = function() {
            var locateFile = wasmPath
                ? function() { return wasmPath; }
                : function(file) { return "https://sql.js.org/dist/" + file; };
            window.initSqlJs({ locateFile: locateFile }).then(function(SQL) {
                SQL_MODULE = SQL;
                resolve(SQL);
            }).catch(reject);
        };
        script.onerror = function() {
            reject(new Error("Failed to load sql.js from CDN"));
        };
        document.head.appendChild(script);
    });
}

// ============================================================
// Helper functions
// ============================================================

function tryParseJson(value) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        return null;
    }
}

function isTableLikeJson(parsed) {
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return false;
    return typeof parsed[0] === "object" && parsed[0] !== null;
}

function getTables(db) {
    var result = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    if (!result.length) return [];
    return result[0].values.map(function(v) { return v[0]; });
}

function getColumns(db, table) {
    var result = db.exec('PRAGMA table_info("' + table + '")');
    if (!result.length) return [];
    return result[0].values.map(function(v) {
        return { name: v[1], type: v[2] || "", notnull: v[3], dflt_value: v[4], pk: v[5] };
    });
}

function getTableData(db, table, limit) {
    var columns = getColumns(db, table);
    var result = db.exec('SELECT * FROM "' + table + '" LIMIT ' + limit);
    var rows = [];
    if (result.length) {
        var colNames = result[0].columns;
        for (var i = 0; i < result[0].values.length; i++) {
            var valueRow = result[0].values[i];
            var row = {};
            for (var j = 0; j < colNames.length; j++) {
                row[colNames[j]] = valueRow[j];
            }
            rows.push(row);
        }
    }
    return { columns: columns, rows: rows };
}

function getRowCount(db, table) {
    var result = db.exec('SELECT COUNT(*) FROM "' + table + '"');
    if (!result.length) return 0;
    return result[0].values[0][0];
}

function prepareValue(value, col) {
    if (value === null || value === undefined || value === "") return null;
    var type = (col.type || "").toUpperCase();
    if (type === "INTEGER") {
        var num = parseInt(value, 10);
        return isNaN(num) ? null : num;
    }
    if (type === "REAL" || type === "FLOAT" || type === "DOUBLE") {
        var num = parseFloat(value);
        return isNaN(num) ? null : num;
    }
    return String(value);
}

// Helper: execute a parameterized SQL statement
// Uses db.run() which internally handles parameter binding correctly
function executeSql(db, sql, params) {
    if (params && params.length > 0) {
        db.run(sql, params);
    } else {
        db.run(sql);
    }
    return true;
}

// ============================================================
// DB File Picker Modal
// ============================================================

var DbFileSuggestModal = (function(_super) {
    __extends(DbFileSuggestModal, _super);
    function DbFileSuggestModal(app, dbFiles, resolve) {
        var _this = _super.call(this, app) || this;
        _this.dbFiles = dbFiles;
        _this.resolveCallback = resolve;
        _this.setPlaceholder("选择一个数据库文件...");
        _this.emptyStateText = "没有找到数据库文件";
        return _this;
    }
    DbFileSuggestModal.prototype.getItems = function() { return this.dbFiles; };
    DbFileSuggestModal.prototype.getItemText = function(item) { return item; };
    DbFileSuggestModal.prototype.onChooseItem = function(item, _evt) { this.resolveCallback(item); };
    return DbFileSuggestModal;
})(obsidian.FuzzySuggestModal);

// ============================================================
// Edit Row Modal
// ============================================================

var EditRowModal = (function(_super) {
    __extends(EditRowModal, _super);
    function EditRowModal(app, columns, rowData, onSave, isEdit) {
        if (isEdit === void 0) { isEdit = true; }
        var _this = _super.call(this, app) || this;
        _this.columns = columns;
        _this.rowData = Object.assign({}, rowData);
        _this.onSave = onSave;
        _this.isEdit = isEdit;
        return _this;
    }
    EditRowModal.prototype.onOpen = function() {
        var _this = this;
        var contentEl = this.contentEl;
        contentEl.empty();
        contentEl.addClass("sqlite-manager-modal");

        var title = this.isEdit ? "编辑记录" : "新增记录";
        contentEl.createEl("h2", { text: title });

        var form = contentEl.createDiv({ cls: "sqlite-manager-form" });
        var inputElements = {};

        for (var _i = 0, _a = this.columns; _i < _a.length; _i++) {
            var col = _a[_i];
            var isAutoIncrement = col.pk === 1 && col.type.toUpperCase() === "INTEGER";
            if (this.isEdit && isAutoIncrement) continue;

            var fieldDiv = form.createDiv({ cls: "sqlite-manager-form-field" });
            var label = fieldDiv.createEl("label", { cls: "sqlite-manager-form-label" });
            label.textContent = col.name;

            if (col.pk === 1) {
                label.createSpan({ cls: "sqlite-manager-badge pk", text: "PK" });
            }
            if (col.notnull && !isAutoIncrement) {
                label.createSpan({ cls: "sqlite-manager-badge required", text: "必填" });
            }
            var typeHint = label.createSpan({ cls: "sqlite-manager-type-hint" });
            typeHint.textContent = col.type || "TEXT";

            var value = this.rowData[col.name];

            // Only detect JSON and show table editor when in edit mode
            var isJsonField = false;
            var parsedJson = null;
            var isTableJson = false;

            if (this.isEdit && typeof value === "string") {
                var trimmed = value.trim();
                if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
                    try {
                        parsedJson = JSON.parse(trimmed);
                        isJsonField = true;
                        if (Array.isArray(parsedJson) && parsedJson.length > 0 && typeof parsedJson[0] === "object" && parsedJson[0] !== null) {
                            isTableJson = true;
                        }
                    } catch (e) {
                        // Not valid JSON, treat as normal string
                    }
                }
            }

            if (isTableJson) {
                // Render as editable table for JSON array of objects
                (function(colName, jsonData) {
                    var editorWrap = fieldDiv.createDiv({ cls: "sqlite-manager-json-editor" });
                    var tableContainer = editorWrap.createDiv({ cls: "sqlite-manager-json-table-container" });
                    var textContainer = editorWrap.createDiv({ cls: "sqlite-manager-json-text-container", attr: { style: "display:none;" } });

                    // Hidden input to store the final value
                    var hiddenInput = fieldDiv.createEl("input", {
                        cls: "sqlite-manager-json-hidden-input",
                        attr: { type: "hidden" }
                    });
                    hiddenInput.value = JSON.stringify(jsonData);
                    inputElements[colName] = hiddenInput;

                    // --- Table editor ---
                    var currentData = jsonData.map(function(item) { return Object.assign({}, item); });
                    var allKeys = new Set();
                    for (var k = 0; k < currentData.length; k++) {
                        Object.keys(currentData[k]).forEach(function(key) { allKeys.add(key); });
                    }
                    var colKeys = Array.from(allKeys);

                    function syncToHidden() {
                        hiddenInput.value = JSON.stringify(currentData);
                    }

                    function renderTable() {
                        tableContainer.empty();
                        if (currentData.length === 0) {
                            tableContainer.createEl("p", { text: "（空数组，点击下方添加行）", cls: "sqlite-manager-json-empty-hint" });
                            syncToHidden();
                            return;
                        }

                        // Re-collect keys
                        allKeys = new Set();
                        for (var k = 0; k < currentData.length; k++) {
                            Object.keys(currentData[k]).forEach(function(key) { allKeys.add(key); });
                        }
                        colKeys = Array.from(allKeys);

                        var table = tableContainer.createEl("table", { cls: "sqlite-manager-edit-table" });
                        var thead = table.createEl("thead");
                        var headerRow = thead.createEl("tr");
                        headerRow.createEl("th", { text: "#", cls: "sqlite-manager-edit-th-num" });
                        for (var ci = 0; ci < colKeys.length; ci++) {
                            (function(keyIdx) {
                                var th = headerRow.createEl("th", { cls: "sqlite-manager-edit-th-col" });
                                var colNameSpan = th.createSpan({ text: colKeys[keyIdx] });
                                var delColBtn = th.createEl("button", { cls: "sqlite-manager-edit-del-col", text: "×", attr: { title: "删除此列" } });
                                delColBtn.addEventListener("click", function(e) {
                                    e.stopPropagation();
                                    var removedKey = colKeys[keyIdx];
                                    for (var ri = 0; ri < currentData.length; ri++) {
                                        delete currentData[ri][removedKey];
                                    }
                                    renderTable();
                                });
                            })(ci);
                        }
                        headerRow.createEl("th", { text: "", cls: "sqlite-manager-edit-th-action" });

                        var tbody = table.createEl("tbody");
                        for (var ri = 0; ri < currentData.length; ri++) {
                            (function(rowIdx) {
                                var tr = tbody.createEl("tr");
                                tr.createEl("td", { text: String(rowIdx + 1), cls: "sqlite-manager-edit-td-num" });
                                for (var ci = 0; ci < colKeys.length; ci++) {
                                    (function(keyIdx2) {
                                        var td = tr.createEl("td", { cls: "sqlite-manager-edit-td-cell" });
                                        var cellInput = td.createEl("input", {
                                            cls: "sqlite-manager-edit-cell-input",
                                            attr: { type: "text", spellcheck: "false" }
                                        });
                                        var cellVal = currentData[rowIdx][colKeys[keyIdx2]];
                                        cellInput.value = cellVal !== null && cellVal !== undefined ? String(cellVal) : "";
                                        cellInput.addEventListener("input", function() {
                                            currentData[rowIdx][colKeys[keyIdx2]] = cellInput.value;
                                            syncToHidden();
                                        });
                                    })(ci);
                                }
                                var actionTd = tr.createEl("td", { cls: "sqlite-manager-edit-td-action" });
                                var delRowBtn = actionTd.createEl("button", { cls: "sqlite-manager-edit-del-row", text: "🗑️", attr: { title: "删除此行" } });
                                delRowBtn.addEventListener("click", function(e) {
                                    e.stopPropagation();
                                    currentData.splice(rowIdx, 1);
                                    renderTable();
                                });
                            })(ri);
                        }

                        syncToHidden();
                    }

                    renderTable();

                    // Add row / Add column buttons
                    var tableActions = editorWrap.createDiv({ cls: "sqlite-manager-json-table-actions" });
                    var addRowBtn = tableActions.createEl("button", { text: "➕ 添加行", cls: "mod-muted" });
                    addRowBtn.addEventListener("click", function() {
                        var newRow = {};
                        for (var ki = 0; ki < colKeys.length; ki++) {
                            newRow[colKeys[ki]] = "";
                        }
                        currentData.push(newRow);
                        renderTable();
                    });
                    var addColBtn = tableActions.createEl("button", { text: "➕ 添加列", cls: "mod-muted" });
                    addColBtn.addEventListener("click", function() {
                        var newColName = "column_" + (colKeys.length + 1);
                        // Find a unique name
                        var attempt = 1;
                        while (colKeys.indexOf(newColName) !== -1) {
                            attempt++;
                            newColName = "column_" + attempt;
                        }
                        for (var ri = 0; ri < currentData.length; ri++) {
                            currentData[ri][newColName] = "";
                        }
                        renderTable();
                    });

                    // --- Textarea (raw JSON) ---
                    var textarea = textContainer.createEl("textarea", {
                        cls: "sqlite-manager-form-input json-input",
                        attr: { placeholder: "输入JSON格式的" + colName, rows: "8", spellcheck: "false" }
                    });
                    textarea.value = JSON.stringify(jsonData, null, 2);

                    // --- Toggle buttons ---
                    var btnGroup = editorWrap.createDiv({ cls: "sqlite-manager-form-btn-group" });
                    var isTableMode = true;
                    var toggleBtn = btnGroup.createEl("button", { text: "📝 切换到原始JSON", cls: "mod-muted" });
                    toggleBtn.addEventListener("click", function() {
                        if (isTableMode) {
                            // Switch to textarea mode: serialize current table data
                            try {
                                textarea.value = JSON.stringify(currentData, null, 2);
                            } catch (e) {
                                textarea.value = JSON.stringify(jsonData, null, 2);
                            }
                            tableContainer.style.display = "none";
                            tableActions.style.display = "none";
                            textContainer.style.display = "block";
                            toggleBtn.textContent = "📊 切换到表格编辑";
                            isTableMode = false;
                        } else {
                            // Switch to table mode: parse textarea content
                            try {
                                var parsed = JSON.parse(textarea.value);
                                if (Array.isArray(parsed)) {
                                    currentData = parsed.map(function(item) { return Object.assign({}, item); });
                                    hiddenInput.value = JSON.stringify(currentData);
                                    renderTable();
                                } else {
                                    new obsidian.Notice("内容不是JSON数组，无法切换到表格模式");
                                    return;
                                }
                            } catch (e) {
                                new obsidian.Notice("JSON格式不正确，无法切换到表格模式");
                                return;
                            }
                            tableContainer.style.display = "block";
                            tableActions.style.display = "flex";
                            textContainer.style.display = "none";
                            toggleBtn.textContent = "📝 切换到原始JSON";
                            isTableMode = true;
                        }
                    });

                    var formatBtn = btnGroup.createEl("button", { text: "格式化JSON", cls: "mod-muted" });
                    formatBtn.addEventListener("click", function() {
                        if (isTableMode) {
                            try {
                                var parsed = JSON.parse(hiddenInput.value);
                                hiddenInput.value = JSON.stringify(parsed, null, 2);
                            } catch (e) {
                                new obsidian.Notice("JSON格式不正确");
                            }
                        } else {
                            try {
                                var parsed = JSON.parse(textarea.value);
                                textarea.value = JSON.stringify(parsed, null, 2);
                            } catch (e) {
                                new obsidian.Notice("JSON格式不正确，无法格式化");
                            }
                        }
                    });

                    // Sync textarea to hiddenInput when in textarea mode
                    textarea.addEventListener("input", function() {
                        if (!isTableMode) {
                            hiddenInput.value = textarea.value;
                        }
                    });

                })(col.name, parsedJson);

            } else if (isJsonField) {
                // JSON but not a table-like array (e.g. object or empty array) - show textarea
                var textarea_1 = fieldDiv.createEl("textarea", {
                    cls: "sqlite-manager-form-input json-input",
                    attr: { placeholder: "输入JSON格式的" + col.name, rows: "6", spellcheck: "false" }
                });
                textarea_1.value = typeof value === "string" ? value : JSON.stringify(value, null, 2);
                inputElements[col.name] = textarea_1;

                var btnGroup = fieldDiv.createDiv({ cls: "sqlite-manager-form-btn-group" });
                var formatBtn = btnGroup.createEl("button", { text: "格式化JSON", cls: "mod-muted" });
                formatBtn.addEventListener("click", function() {
                    try {
                        var parsed = JSON.parse(textarea_1.value);
                        textarea_1.value = JSON.stringify(parsed, null, 2);
                    } catch (e) {
                        new obsidian.Notice("JSON格式不正确，无法格式化");
                    }
                });
                var compressBtn = btnGroup.createEl("button", { text: "压缩JSON", cls: "mod-muted" });
                compressBtn.addEventListener("click", function() {
                    try {
                        var parsed = JSON.parse(textarea_1.value);
                        textarea_1.value = JSON.stringify(parsed);
                    } catch (e) {
                        new obsidian.Notice("JSON格式不正确，无法压缩");
                    }
                });
            } else {
                var input_1 = fieldDiv.createEl("input", {
                    cls: "sqlite-manager-form-input",
                    attr: {
                        type: "text",
                        placeholder: isAutoIncrement ? "自动生成" : "输入" + col.name,
                        spellcheck: "false"
                    }
                });
                input_1.value = value !== null && value !== undefined ? String(value) : "";
                if (isAutoIncrement) input_1.disabled = true;
                inputElements[col.name] = input_1;
            }
        }

        var btnDiv = contentEl.createDiv({ cls: "sqlite-manager-form-actions" });
        var saveBtn = btnDiv.createEl("button", { text: "保存", cls: "mod-cta" });
        saveBtn.addEventListener("click", function(e) {
            e.preventDefault();
            var newData = {};
            for (var _i = 0, _a = _this.columns; _i < _a.length; _i++) {
                var col = _a[_i];
                var isAutoIncrement = col.pk === 1 && col.type.toUpperCase() === "INTEGER";
                if (_this.isEdit && isAutoIncrement) {
                    newData[col.name] = _this.rowData[col.name];
                    continue;
                }
                var el = inputElements[col.name];
                newData[col.name] = el ? (el.value || null) : null;
            }
            _this.onSave(newData);
            _this.close();
        });
        var cancelBtn = btnDiv.createEl("button", { text: "取消" });
        cancelBtn.addEventListener("click", function() { _this.close(); });
    };
    EditRowModal.prototype.onClose = function() { this.contentEl.empty(); };
    return EditRowModal;
})(obsidian.Modal);

// ============================================================
// Confirm Delete Modal
// ============================================================

var ConfirmDeleteModal = (function(_super) {
    __extends(ConfirmDeleteModal, _super);
    function ConfirmDeleteModal(app, message, onConfirm) {
        var _this = _super.call(this, app) || this;
        _this.message = message;
        _this.onConfirm = onConfirm;
        return _this;
    }
    ConfirmDeleteModal.prototype.onOpen = function() {
        var _this = this;
        var contentEl = this.contentEl;
        contentEl.empty();
        contentEl.addClass("sqlite-manager-modal");

        contentEl.createEl("h2", { text: "确认删除" });
        contentEl.createEl("p", { text: this.message, cls: "sqlite-manager-confirm-text" });

        var btnDiv = contentEl.createDiv({ cls: "sqlite-manager-form-actions" });
        var deleteBtn = btnDiv.createEl("button", { text: "删除", cls: "mod-warning" });
        deleteBtn.addEventListener("click", function() { _this.onConfirm(); _this.close(); });
        var cancelBtn = btnDiv.createEl("button", { text: "取消" });
        cancelBtn.addEventListener("click", function() { _this.close(); });
    };
    ConfirmDeleteModal.prototype.onClose = function() { this.contentEl.empty(); };
    return ConfirmDeleteModal;
})(obsidian.Modal);

// ============================================================
// JSON Detail View Modal
// ============================================================

var JsonDetailModal = (function(_super) {
    __extends(JsonDetailModal, _super);
    function JsonDetailModal(app, fieldName, jsonData) {
        var _this = _super.call(this, app) || this;
        _this.fieldName = fieldName;
        _this.jsonData = jsonData;
        return _this;
    }
    JsonDetailModal.prototype.onOpen = function() {
        var _this = this;
        var contentEl = this.contentEl;
        contentEl.empty();
        contentEl.addClass("sqlite-manager-modal");
        contentEl.addClass("sqlite-manager-json-modal");

        contentEl.createEl("h2", { text: this.fieldName + " - 详细视图" });

        if (isTableLikeJson(this.jsonData)) {
            this.renderTableLikeJson(contentEl, this.jsonData);
        } else if (typeof this.jsonData === "object" && this.jsonData !== null) {
            this.renderObjectJson(contentEl, this.jsonData);
        } else {
            contentEl.createEl("pre", {
                text: JSON.stringify(this.jsonData, null, 2),
                cls: "sqlite-manager-json-pre"
            });
        }

        var btnDiv = contentEl.createDiv({ cls: "sqlite-manager-form-actions" });
        var closeBtn = btnDiv.createEl("button", { text: "关闭" });
        closeBtn.addEventListener("click", function() { _this.close(); });
    };

    JsonDetailModal.prototype.renderTableLikeJson = function(container, data) {
        var _this = this;
        if (data.length === 0) {
            container.createEl("p", { text: "（空数组）" });
            return;
        }
        var keys = new Set();
        for (var _i = 0, data_1 = data; _i < data_1.length; _i++) {
            var item = data_1[_i];
            if (typeof item === "object" && item !== null) {
                Object.keys(item).forEach(function(k) { keys.add(k); });
            }
        }
        var columns = Array.from(keys);

        var wrap = container.createDiv({ cls: "sqlite-manager-json-table-wrap" });
        var table = wrap.createEl("table", { cls: "sqlite-manager-json-table" });

        var thead = table.createEl("thead");
        var headerRow = thead.createEl("tr");
        headerRow.createEl("th", { text: "#" });
        for (var _a = 0, columns_1 = columns; _a < columns_1.length; _a++) {
            var col = columns_1[_a];
            headerRow.createEl("th", { text: col });
        }

        var tbody = table.createEl("tbody");
        for (var i = 0; i < data.length; i++) {
            var row = data[i];
            var tr = tbody.createEl("tr");
            tr.createEl("td", { cls: "sqlite-manager-row-num", text: String(i + 1) });
            for (var _b = 0, columns_2 = columns; _b < columns_2.length; _b++) {
                var col = columns_2[_b];
                var td = tr.createEl("td");
                var val = row[col];
                if (val === null || val === undefined) {
                    td.createSpan({ cls: "sqlite-manager-null", text: "NULL" });
                } else if (typeof val === "object") {
                    var nested = tryParseJson(val);
                    if (nested) {
                        var btn = td.createEl("button", {
                            cls: "sqlite-manager-json-expand-btn",
                            text: "📋 查看JSON"
                        });
                        (function(fieldName, nestedData) {
                            btn.addEventListener("click", function() {
                                new JsonDetailModal(_this.app, fieldName, nestedData).open();
                            });
                        })(col + "[" + i + "]", nested);
                    } else {
                        td.textContent = JSON.stringify(val);
                    }
                } else {
                    td.textContent = String(val);
                }
            }
        }

        container.createEl("div", {
            cls: "sqlite-manager-json-summary",
            text: "共 " + data.length + " 条记录"
        });
    };

    JsonDetailModal.prototype.renderObjectJson = function(container, data) {
        var _this = this;
        var wrap = container.createDiv({ cls: "sqlite-manager-json-kv-wrap" });
        var _loop_1 = function(key) {
            var value = data[key];
            var row = wrap.createDiv({ cls: "sqlite-manager-json-kv-row" });
            row.createEl("span", { cls: "sqlite-manager-json-kv-key", text: key });
            var valSpan = row.createEl("span", { cls: "sqlite-manager-json-kv-value" });
            if (value === null || value === undefined) {
                valSpan.createSpan({ cls: "sqlite-manager-null", text: "NULL" });
            } else if (typeof value === "object") {
                var nested = tryParseJson(value);
                if (nested) {
                    var btn = valSpan.createEl("button", {
                        cls: "sqlite-manager-json-expand-btn",
                        text: "📋 查看JSON"
                    });
                    btn.addEventListener("click", function() {
                        new JsonDetailModal(_this.app, key, nested).open();
                    });
                } else {
                    valSpan.textContent = JSON.stringify(value);
                }
            } else {
                valSpan.textContent = String(value);
            }
        };
        for (var key in data) {
            if (data.hasOwnProperty(key)) _loop_1(key);
        }
    };

    JsonDetailModal.prototype.onClose = function() { this.contentEl.empty(); };
    return JsonDetailModal;
})(obsidian.Modal);

// ============================================================
// SQLite Manager View
// ============================================================

var VIEW_TYPE_SQLITE_MANAGER = "sqlite-manager-view";

var SqliteManagerView = (function(_super) {
    __extends(SqliteManagerView, _super);

    function SqliteManagerView(leaf, plugin) {
        var _this = _super.call(this, leaf) || this;
        _this.plugin = plugin;
        _this.db = null;
        _this.currentFile = null;
        _this.currentTable = null;
        _this.currentData = null;
        _this.sortColumn = null;
        _this.sortDirection = "asc";
        _this.searchQuery = "";
        return _this;
    }

    SqliteManagerView.prototype.getViewType = function() { return VIEW_TYPE_SQLITE_MANAGER; };
    SqliteManagerView.prototype.getDisplayText = function() {
        return this.currentFile ? "SQLite: " + this.currentFile : "SQLite Manager";
    };
    SqliteManagerView.prototype.getIcon = function() { return "database"; };
    SqliteManagerView.prototype.onOpen = function() { this.renderView(); };
    SqliteManagerView.prototype.onClose = function() { this.closeDatabase(); };

    SqliteManagerView.prototype.closeDatabase = function() {
        if (this.db) { this.db.close(); this.db = null; }
        this.currentFile = null;
        this.currentTable = null;
        this.currentData = null;
    };

    SqliteManagerView.prototype.openDbFile = function(filePath) {
        var _this = this;
        this.closeDatabase();
        getSqlJs(this.plugin.settings.wasmPath).then(function(SQL) {
            var file = _this.app.vault.getAbstractFileByPath(filePath);
            if (!file || !(file instanceof obsidian.TFile)) {
                new obsidian.Notice("找不到文件: " + filePath);
                return;
            }
            _this.app.vault.readBinary(file).then(function(buffer) {
                try {
                    _this.db = new SQL.Database(new Uint8Array(buffer));
                    _this.currentFile = filePath;
                    _this.currentTable = null;
                    _this.currentData = null;
                    _this.renderView();
                } catch (err) {
                    new obsidian.Notice("打开数据库失败: " + err.message);
                }
            });
        }).catch(function(err) {
            new obsidian.Notice("加载SQL引擎失败: " + err.message);
            console.error("加载SQL引擎失败:", err);
        });
    };

    SqliteManagerView.prototype.renderView = function() {
        var container = this.containerEl.children[1];
        container.empty();
        container.addClass("sqlite-manager");
        this.renderToolbar(container);
        if (!this.db) { this.renderEmptyState(container); return; }
        this.renderTableSelector(container);
        if (this.currentTable && this.currentData) { this.renderDataTable(container); }
    };

    SqliteManagerView.prototype.renderToolbar = function(container) {
        var _this = this;
        var toolbar = container.createDiv({ cls: "sqlite-manager-toolbar" });
        var fileLabel = toolbar.createDiv({ cls: "sqlite-manager-file-label" });
        fileLabel.textContent = this.currentFile ? "📁 " + this.currentFile : "未打开数据库";

        var btnGroup = toolbar.createDiv({ cls: "sqlite-manager-toolbar-btns" });
        var openBtn = btnGroup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "打开数据库文件" } });
        openBtn.innerHTML = "📂 打开";
        openBtn.addEventListener("click", function() { _this.pickDbFile(); });

        if (this.db) {
            var refreshBtn = btnGroup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "刷新数据" } });
            refreshBtn.innerHTML = "🔄 刷新";
            refreshBtn.addEventListener("click", function() { _this.refreshData(); });
            var saveBtn = btnGroup.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "保存数据库" } });
            saveBtn.innerHTML = "💾 保存";
            saveBtn.addEventListener("click", function() { _this.saveDatabase(); });
        }
    };

    SqliteManagerView.prototype.renderEmptyState = function(container) {
        var _this = this;
        var empty = container.createDiv({ cls: "sqlite-manager-empty" });
        empty.createEl("div", { cls: "sqlite-manager-empty-icon", text: "🗄️" });
        empty.createEl("h3", { text: "SQLite Manager" });
        empty.createEl("p", { text: "点击「打开」按钮选择一个 .db 文件，或使用命令面板打开数据库。" });
        var openBtn = empty.createEl("button", { text: "📂 打开数据库文件", cls: "mod-cta" });
        openBtn.addEventListener("click", function() { _this.pickDbFile(); });
    };

    SqliteManagerView.prototype.renderTableSelector = function(container) {
        var _this = this;
        var selector = container.createDiv({ cls: "sqlite-manager-table-selector" });
        var tables = getTables(this.db);

        var dropdownWrap = selector.createDiv({ cls: "sqlite-manager-dropdown-wrap" });
        dropdownWrap.createEl("span", { cls: "sqlite-manager-selector-label", text: "表:" });
        var dropdown = dropdownWrap.createEl("select", { cls: "sqlite-manager-dropdown" });
        dropdown.createEl("option", { text: "-- 选择表 --", attr: { value: "" } });
        for (var _i = 0, tables_1 = tables; _i < tables_1.length; _i++) {
            var table = tables_1[_i];
            var opt = dropdown.createEl("option", { text: table, attr: { value: table } });
            if (table === this.currentTable) opt.selected = true;
        }
        dropdown.addEventListener("change", function() {
            var val = dropdown.value;
            if (val) _this.selectTable(val);
        });

        var searchWrap = selector.createDiv({ cls: "sqlite-manager-search-wrap" });
        var searchInput = searchWrap.createEl("input", {
            cls: "sqlite-manager-search-input",
            attr: { type: "text", placeholder: "🔍 搜索数据...", value: this.searchQuery }
        });
        searchInput.addEventListener("input", function() {
            _this.searchQuery = searchInput.value;
            if (_this.currentTable) _this.renderView();
        });

        if (this.currentTable) {
            var count = getRowCount(this.db, this.currentTable);
            selector.createDiv({ cls: "sqlite-manager-row-count", text: "共 " + count + " 行" });
        }
    };

    SqliteManagerView.prototype.selectTable = function(tableName) {
        this.currentTable = tableName;
        this.sortColumn = null;
        this.sortDirection = "asc";
        this.searchQuery = "";
        this.currentData = getTableData(this.db, tableName, this.plugin.settings.previewLimit);
        this.renderView();
    };

    SqliteManagerView.prototype.refreshData = function() {
        if (this.currentFile) this.openDbFile(this.currentFile);
    };

    SqliteManagerView.prototype.renderDataTable = function(container) {
        var _this = this;
        if (!this.currentData || !this.currentTable) return;

        var rows = this.currentData.rows.slice();

        // Search filter
        if (this.searchQuery) {
            var query_1 = this.searchQuery.toLowerCase();
            rows = rows.filter(function(row) {
                return Object.values(row).some(function(v) { return String(v).toLowerCase().includes(query_1); });
            });
        }

        // Sort
        if (this.sortColumn) {
            var sortCol_1 = this.sortColumn;
            var sortDir_1 = this.sortDirection;
            rows.sort(function(a, b) {
                var va = a[sortCol_1], vb = b[sortCol_1];
                if (va === null || va === undefined) return 1;
                if (vb === null || vb === undefined) return -1;
                var cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
                return sortDir_1 === "asc" ? cmp : -cmp;
            });
        }

        // Action buttons
        var actionsBar = container.createDiv({ cls: "sqlite-manager-actions" });
        var addBtn = actionsBar.createEl("button", { cls: "sqlite-manager-btn sqlite-manager-btn-add", text: "➕ 新增记录" });
        addBtn.addEventListener("click", function() { _this.addRow(); });
        var exportBtn = actionsBar.createEl("button", { cls: "sqlite-manager-btn sqlite-manager-btn-export", text: "📋 复制为JSON" });
        exportBtn.addEventListener("click", function() { _this.copyAsJson(rows); });

        // Table
        var tableWrap = container.createDiv({ cls: "sqlite-manager-table-wrap" });
        var table = tableWrap.createEl("table", { cls: "sqlite-manager-table" });

        // Header
        var thead = table.createEl("thead");
        var headerRow = thead.createEl("tr");
        headerRow.createEl("th", { text: "操作", cls: "sqlite-manager-th-actions" });

        for (var _i = 0, _a = this.currentData.columns; _i < _a.length; _i++) {
            var col = _a[_i];
            var th = headerRow.createEl("th", { cls: "sqlite-manager-th-sortable" });
            var thWrap = th.createDiv({ cls: "sqlite-manager-th-wrap" });
            var labelDiv = thWrap.createDiv({ cls: "sqlite-manager-th-labels" });
            labelDiv.createDiv({ cls: "sqlite-manager-th-label", text: col.name });
            labelDiv.createDiv({ cls: "sqlite-manager-th-type", text: col.type || "TEXT" });
            if (this.sortColumn === col.name) {
                thWrap.createDiv({
                    cls: "sqlite-manager-sort-icon active " + this.sortDirection,
                    text: this.sortDirection === "asc" ? "▲" : "▼"
                });
            }
            (function(colName) {
                th.addEventListener("click", function() {
                    if (_this.sortColumn === colName) {
                        _this.sortDirection = _this.sortDirection === "asc" ? "desc" : "asc";
                    } else {
                        _this.sortColumn = colName;
                        _this.sortDirection = "asc";
                    }
                    _this.renderView();
                });
            })(col.name);
        }

        // Body
        var tbody = table.createEl("tbody");
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var tr = tbody.createEl("tr");

            var actionTd = tr.createEl("td", { cls: "sqlite-manager-td-actions" });
            var editBtn = actionTd.createEl("button", { cls: "sqlite-manager-row-btn edit", text: "✏️", attr: { title: "编辑" } });
            (function(r) { editBtn.addEventListener("click", function() { _this.editRow(r); }); })(row);
            var deleteBtn = actionTd.createEl("button", { cls: "sqlite-manager-row-btn delete", text: "🗑️", attr: { title: "删除" } });
            (function(r) { deleteBtn.addEventListener("click", function() { _this.deleteRow(r); }); })(row);

            for (var _b = 0, _c = this.currentData.columns; _b < _c.length; _b++) {
                var col = _c[_b];
                var td = tr.createEl("td");
                var value = row[col.name];

                if (value === null || value === undefined) {
                    td.createSpan({ cls: "sqlite-manager-null", text: "NULL" });
                } else {
                    var parsed = tryParseJson(value);
                    if (parsed !== null && isTableLikeJson(parsed)) {
                        this.renderInlineJsonTable(td, col.name, parsed);
                    } else if (parsed !== null && typeof parsed === "object") {
                        var btn = td.createEl("button", {
                            cls: "sqlite-manager-json-btn",
                            text: "📋 {" + Object.keys(parsed).length + "项}"
                        });
                        (function(colName, pd) {
                            btn.addEventListener("click", function() { new JsonDetailModal(_this.app, colName, pd).open(); });
                        })(col.name, parsed);
                    } else if (parsed !== null && Array.isArray(parsed) && parsed.length === 0) {
                        td.createSpan({ cls: "sqlite-manager-empty-array", text: "[]" });
                    } else if (parsed !== null && Array.isArray(parsed) && typeof parsed[0] !== "object") {
                        td.textContent = parsed.join(", ");
                        td.addClass("sqlite-manager-cell-array");
                    } else {
                        var strVal = String(value);
                        if (strVal.length > 50) {
                            td.textContent = strVal.substring(0, 50) + "...";
                            td.addClass("sqlite-manager-cell-truncated");
                            (function(ft) { td.addEventListener("click", function() { new obsidian.Notice(ft, 5000); }); })(strVal);
                        } else {
                            td.textContent = strVal;
                        }
                        if (typeof value === "number") td.addClass("sqlite-manager-cell-num");
                    }
                }
            }
        }

        if (rows.length === 0) {
            var emptyRow = tbody.createEl("tr");
            var emptyCell = emptyRow.createEl("td", {
                cls: "sqlite-manager-no-data",
                attr: { colspan: String(this.currentData.columns.length + 1) }
            });
            emptyCell.textContent = this.searchQuery ? "没有匹配的数据" : "表中暂无数据";
        }
    };

    SqliteManagerView.prototype.renderInlineJsonTable = function(td, fieldName, data) {
        var _this = this;
        var wrapper = td.createDiv({ cls: "sqlite-manager-inline-json" });
        var header = wrapper.createDiv({ cls: "sqlite-manager-inline-json-header" });
        header.createSpan({ text: data.length + "条", cls: "sqlite-manager-inline-json-count" });
        var expandBtn = header.createEl("button", { cls: "sqlite-manager-inline-json-expand", text: "展开" });
        expandBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            new JsonDetailModal(_this.app, fieldName, data).open();
        });

        if (data.length > 0 && typeof data[0] === "object") {
            var allKeys = new Set();
            for (var _i = 0, data_2 = data; _i < data_2.length; _i++) {
                var item = data_2[_i];
                Object.keys(item).forEach(function(k) { allKeys.add(k); });
            }
            var keys = Array.from(allKeys).slice(0, 4);
            var showRows = data.slice(0, 3);

            var miniTable = wrapper.createEl("table", { cls: "sqlite-manager-mini-table" });
            var thead = miniTable.createEl("thead");
            var headerRow = thead.createEl("tr");
            for (var _a = 0, keys_1 = keys; _a < keys_1.length; _a++) { headerRow.createEl("th", { text: keys_1[_a] }); }

            var tbody = miniTable.createEl("tbody");
            for (var _b = 0, showRows_1 = showRows; _b < showRows_1.length; _b++) {
                var item = showRows_1[_b];
                var row = tbody.createEl("tr");
                for (var _c = 0, keys_2 = keys; _c < keys_2.length; _c++) {
                    var key = keys_2[_c];
                    var cell = row.createEl("td");
                    var val = item[key];
                    if (val === null || val === undefined) {
                        cell.createSpan({ cls: "sqlite-manager-null", text: "-" });
                    } else {
                        cell.textContent = String(val).length > 15 ? String(val).substring(0, 15) + "..." : String(val);
                    }
                }
            }

            if (data.length > 3) {
                var moreRow = tbody.createEl("tr", { cls: "sqlite-manager-more-row" });
                var moreCell = moreRow.createEl("td", { attr: { colspan: String(keys.length) } });
                moreCell.textContent = "还有 " + (data.length - 3) + " 条...";
            }
        }
    };

    // CRUD Operations

    SqliteManagerView.prototype.saveDatabase = function() {
        var _this = this;
        if (!this.db || !this.currentFile) {
            new obsidian.Notice("没有打开的数据库");
            return;
        }
        try {
            var data = this.db.export();
            var buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            var file = this.app.vault.getAbstractFileByPath(this.currentFile);
            if (file && file instanceof obsidian.TFile) {
                this.app.vault.modifyBinary(file, buffer).then(function() {
                    new obsidian.Notice("数据库已保存");
                });
            }
        } catch (err) {
            new obsidian.Notice("保存失败: " + err.message);
        }
    };

    SqliteManagerView.prototype.editRow = function(row) {
        var _this = this;
        if (!this.db || !this.currentTable || !this.currentData) return;
        var modal = new EditRowModal(this.app, this.currentData.columns, row, function(newData) {
            try {
                var pkColumns = _this.currentData.columns.filter(function(c) { return c.pk === 1; });
                if (pkColumns.length === 0) {
                    new obsidian.Notice("该表没有主键，无法编辑");
                    return;
                }
                var setClauses = [];
                var values = [];
                for (var _i = 0, _a = _this.currentData.columns; _i < _a.length; _i++) {
                    var col = _a[_i];
                    if (col.pk === 1) continue;
                    setClauses.push('"' + col.name + '" = ?');
                    values.push(prepareValue(newData[col.name], col));
                }
                var whereClauses = pkColumns.map(function(col) { return '"' + col.name + '" = ?'; });
                var whereValues = pkColumns.map(function(col) { return row[col.name]; });
                var allValues = values.concat(whereValues);
                var sql = 'UPDATE "' + _this.currentTable + '" SET ' + setClauses.join(", ") + ' WHERE ' + whereClauses.join(" AND ");
                console.log("[SQLite Manager] UPDATE SQL:", sql);
                console.log("[SQLite Manager] UPDATE Values:", allValues);
                executeSql(_this.db, sql, allValues);
                new obsidian.Notice("记录已更新（请保存数据库以持久化更改）");
                _this.currentData = getTableData(_this.db, _this.currentTable, _this.plugin.settings.previewLimit);
                _this.renderView();
            } catch (err) {
                console.error("[SQLite Manager] Update error:", err);
                new obsidian.Notice("更新失败: " + err.message);
            }
        }, true);
        modal.open();
    };

    SqliteManagerView.prototype.deleteRow = function(row) {
        var _this = this;
        if (!this.db || !this.currentTable || !this.currentData) return;
        var pkColumns = this.currentData.columns.filter(function(c) { return c.pk === 1; });
        if (pkColumns.length === 0) {
            new obsidian.Notice("该表没有主键，无法删除");
            return;
        }
        var pkValues = pkColumns.map(function(col) { return col.name + "=" + row[col.name]; }).join(", ");
        var modal = new ConfirmDeleteModal(this.app, "确定要删除这条记录吗？\n" + pkValues, function() {
            try {
                var whereClauses = pkColumns.map(function(col) { return '"' + col.name + '" = ?'; });
                var whereValues = pkColumns.map(function(col) { return row[col.name]; });
                var sql = 'DELETE FROM "' + _this.currentTable + '" WHERE ' + whereClauses.join(" AND ");
                console.log("[SQLite Manager] DELETE SQL:", sql);
                console.log("[SQLite Manager] DELETE Values:", whereValues);
                executeSql(_this.db, sql, whereValues);
                new obsidian.Notice("记录已删除（请保存数据库以持久化更改）");
                _this.currentData = getTableData(_this.db, _this.currentTable, _this.plugin.settings.previewLimit);
                _this.renderView();
            } catch (err) {
                console.error("[SQLite Manager] Delete error:", err);
                new obsidian.Notice("删除失败: " + err.message);
            }
        });
        modal.open();
    };

    SqliteManagerView.prototype.addRow = function() {
        var _this = this;
        if (!this.db || !this.currentTable || !this.currentData) return;
        var emptyRow = {};
        for (var _i = 0, _a = this.currentData.columns; _i < _a.length; _i++) {
            var col = _a[_i];
            var isAutoIncrement = col.pk === 1 && col.type.toUpperCase() === "INTEGER";
            emptyRow[col.name] = isAutoIncrement ? null : (col.dflt_value || null);
        }
        var modal = new EditRowModal(this.app, this.currentData.columns, emptyRow, function(newData) {
            try {
                var insertColumns = [];
                var insertValues = [];
                var placeholders = [];
                for (var _i = 0, _a = _this.currentData.columns; _i < _a.length; _i++) {
                    var col = _a[_i];
                    var isAutoIncrement = col.pk === 1 && col.type.toUpperCase() === "INTEGER";
                    if (isAutoIncrement && newData[col.name] === null) continue;
                    if (newData[col.name] === null || newData[col.name] === undefined || newData[col.name] === "") {
                        if (col.notnull && col.dflt_value === null) {
                            new obsidian.Notice(col.name + " 不能为空");
                            return;
                        }
                        if (!col.notnull) {
                            insertColumns.push('"' + col.name + '"');
                            placeholders.push("NULL");
                            continue;
                        }
                    }
                    insertColumns.push('"' + col.name + '"');
                    placeholders.push("?");
                    insertValues.push(prepareValue(newData[col.name], col));
                }
                var sql = 'INSERT INTO "' + _this.currentTable + '" (' + insertColumns.join(", ") + ') VALUES (' + placeholders.join(", ") + ')';
                console.log("[SQLite Manager] INSERT SQL:", sql);
                console.log("[SQLite Manager] INSERT Values:", insertValues);
                executeSql(_this.db, sql, insertValues);
                new obsidian.Notice("记录已添加（请保存数据库以持久化更改）");
                _this.currentData = getTableData(_this.db, _this.currentTable, _this.plugin.settings.previewLimit);
                _this.renderView();
            } catch (err) {
                new obsidian.Notice("新增失败: " + err.message);
            }
        }, false);
        modal.open();
    };

    SqliteManagerView.prototype.copyAsJson = function(rows) {
        navigator.clipboard.writeText(JSON.stringify(rows, null, 2)).then(function() {
            new obsidian.Notice("已复制到剪贴板");
        });
    };

    SqliteManagerView.prototype.pickDbFile = function() {
        var _this = this;
        var dbFiles = this.findDbFiles();
        if (dbFiles.length === 0) { new obsidian.Notice("未找到 .db 文件"); return; }
        if (dbFiles.length === 1) { this.openDbFile(dbFiles[0]); return; }
        var modal = new DbFileSuggestModal(this.app, dbFiles, function(filePath) {
            if (filePath) _this.openDbFile(filePath);
        });
        modal.open();
    };

    SqliteManagerView.prototype.findDbFiles = function() {
        return this.app.vault.getFiles()
            .filter(function(f) { return f.extension === "db" || f.extension === "sqlite" || f.extension === "sqlite3"; })
            .map(function(f) { return f.path; })
            .sort();
    };

    return SqliteManagerView;
})(obsidian.ItemView);

// ============================================================
// Main Plugin Class
// ============================================================

var SqliteManagerPlugin = (function(_super) {
    __extends(SqliteManagerPlugin, _super);

    function SqliteManagerPlugin(app, manifest) {
        var _this = _super.call(this, app, manifest) || this;
        _this.settings = { wasmPath: "", previewLimit: 200 };
        _this.view = null;
        return _this;
    }

    SqliteManagerPlugin.prototype.onload = function() {
        var _this = this;
        this.loadSettings().then(function() {
            _this.registerView(VIEW_TYPE_SQLITE_MANAGER, function(leaf) {
                _this.view = new SqliteManagerView(leaf, _this);
                return _this.view;
            });

            _this.addRibbonIcon("database", "打开 SQLite Manager", function() {
                _this.activateView();
            });

            _this.addCommand({
                id: "open-sqlite-manager",
                name: "打开 SQLite Manager",
                callback: function() { _this.activateView(); }
            });

            _this.addCommand({
                id: "open-database-file",
                name: "打开数据库文件",
                callback: function() {
                    _this.activateView().then(function() {
                        if (_this.view) _this.view.pickDbFile();
                    });
                }
            });

            _this.addSettingTab(new SqliteManagerSettingTab(_this.app, _this));
            _this.registerExtensions(["db", "sqlite", "sqlite3"], VIEW_TYPE_SQLITE_MANAGER);

            // Auto-open database when a .db file is clicked
            _this.app.workspace.on("active-leaf-change", function(leaf) {
                if (leaf && leaf.view && leaf.view.getViewType && leaf.view.getViewType() === VIEW_TYPE_SQLITE_MANAGER) {
                    var view = leaf.view;
                    if (view.currentFile === null && view.db === null) {
                        // Try to get the file from the leaf's state
                        var state = leaf.getViewState();
                        if (state && state.state && state.state.file) {
                            view.openDbFile(state.state.file);
                        }
                    }
                }
            });
        });
    };

    SqliteManagerPlugin.prototype.onunload = function() {
        if (this.view) this.view.closeDatabase();
    };

    SqliteManagerPlugin.prototype.loadSettings = function() {
        var _this = this;
        return this.loadData().then(function(data) {
            _this.settings = Object.assign({}, { wasmPath: "", previewLimit: 200 }, data);
        });
    };

    SqliteManagerPlugin.prototype.saveSettings = function() {
        return this.saveData(this.settings);
    };

    SqliteManagerPlugin.prototype.activateView = function() {
        var workspace = this.app.workspace;
        var leaves = workspace.getLeavesOfType(VIEW_TYPE_SQLITE_MANAGER);
        var leaf = null;
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                leaf.setViewState({ type: VIEW_TYPE_SQLITE_MANAGER, active: true });
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
        return Promise.resolve();
    };

    return SqliteManagerPlugin;
})(obsidian.Plugin);

// ============================================================
// Settings Tab
// ============================================================

var SqliteManagerSettingTab = (function(_super) {
    __extends(SqliteManagerSettingTab, _super);

    function SqliteManagerSettingTab(app, plugin) {
        var _this = _super.call(this, app, plugin) || this;
        _this.plugin = plugin;
        return _this;
    }

    SqliteManagerSettingTab.prototype.display = function() {
        var _this = this;
        var containerEl = this.containerEl;
        containerEl.empty();
        containerEl.createEl("h2", { text: "SQLite Manager 设置" });

        new obsidian.Setting(containerEl)
            .setName("sql.js WASM 路径")
            .setDesc("sql.js 的 WASM 文件路径。留空则从 CDN 加载。")
            .addText(function(text) {
                text.setPlaceholder("留空使用CDN")
                    .setValue(_this.plugin.settings.wasmPath)
                    .onChange(function(value) {
                        _this.plugin.settings.wasmPath = value;
                        _this.plugin.saveSettings();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName("预览行数限制")
            .setDesc("查看表数据时的最大行数")
            .addSlider(function(slider) {
                slider.setLimits(10, 1000, 10)
                    .setValue(_this.plugin.settings.previewLimit)
                    .setDynamicTooltip()
                    .onChange(function(value) {
                        _this.plugin.settings.previewLimit = value;
                        _this.plugin.saveSettings();
                    });
            });
    };

    return SqliteManagerSettingTab;
})(obsidian.PluginSettingTab);

module.exports = SqliteManagerPlugin;
