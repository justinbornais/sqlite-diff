import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;
type SqliteDatabase = InstanceType<SqlJsModule['Database']>;
type SqliteValue = string | number | Uint8Array | null;

const MAX_SAMPLE_ROWS = 20;
const INTERNAL_TABLE_PREFIX = 'sqlite_';
const ABSENT_VALUE = '(missing)';

export type CompareOptions = {
  schema: boolean;
  metadata: boolean;
  data: boolean;
};

export type MetadataDifference = {
  label: string;
  left: string;
  right: string;
  status: 'same' | 'different';
};

export type RowPreview = {
  key: string;
  values: Record<string, string>;
};

export type ChangedRow = {
  key: string;
  keyLabel: string;
  differingColumns: string[];
  left: RowPreview;
  right: RowPreview;
};

export type SchemaTableDiff = {
  tableName: string;
  summary: string;
  definitionChanged: boolean;
  columns: {
    onlyInLeft: string[];
    onlyInRight: string[];
    changed: Array<{
      columnName: string;
      differences: string[];
      leftSignature: string;
      rightSignature: string;
    }>;
  };
  indexes: {
    onlyInLeft: string[];
    onlyInRight: string[];
    changed: string[];
  };
  foreignKeys: {
    onlyInLeft: string[];
    onlyInRight: string[];
  };
};

export type DataTableDiff = {
  tableName: string;
  columns: string[];
  keyMode: 'primary-key' | 'full-row';
  note?: string;
  leftRowCount: number;
  rightRowCount: number;
  onlyInLeftCount: number;
  onlyInRightCount: number;
  changedCount: number;
  onlyInLeft: RowPreview[];
  onlyInRight: RowPreview[];
  changedRows: ChangedRow[];
};

export type CompareResult = {
  left: {
    name: string;
    size: number;
    lastModified: number;
  };
  right: {
    name: string;
    size: number;
    lastModified: number;
  };
  summary: {
    schemaDifferences: number;
    metadataDifferences: number;
    dataDifferences: number;
    commonTables: number;
  };
  schema?: {
    tablesOnlyInLeft: string[];
    tablesOnlyInRight: string[];
    tableDiffs: SchemaTableDiff[];
    viewDiffs: Array<{
      name: string;
      status: 'only-left' | 'only-right' | 'definition-changed';
    }>;
  };
  metadata?: {
    differences: MetadataDifference[];
  };
  data?: {
    tableDiffs: DataTableDiff[];
  };
};

type TableColumn = {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  hidden: number;
};

type TableIndex = {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
};

type ForeignKey = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
  match: string;
};

type TableSnapshot = {
  name: string;
  definitionSql: string;
  columns: TableColumn[];
  indexes: TableIndex[];
  foreignKeys: ForeignKey[];
};

type DatabaseMetadata = Record<string, string>;

type DatabaseSnapshot = {
  metadata: DatabaseMetadata;
  tables: Record<string, TableSnapshot>;
  tableNames: string[];
  views: Record<string, string>;
};

let sqlJsPromise: Promise<SqlJsModule> | null = null;

export async function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => wasmUrl,
    });
  }

  return sqlJsPromise;
}

export async function compareSqliteFiles(
  leftFile: File,
  rightFile: File,
  options: CompareOptions,
): Promise<CompareResult> {
  const sqlite = await getSqlJs();
  const [leftBuffer, rightBuffer] = await Promise.all([leftFile.arrayBuffer(), rightFile.arrayBuffer()]);

  const leftDatabase = new sqlite.Database(new Uint8Array(leftBuffer));
  const rightDatabase = new sqlite.Database(new Uint8Array(rightBuffer));

  try {
    const leftSnapshot = snapshotDatabase(leftDatabase);
    const rightSnapshot = snapshotDatabase(rightDatabase);

    const commonTables = leftSnapshot.tableNames.filter((tableName) => rightSnapshot.tables[tableName]);
    const schema = options.schema ? compareSchema(leftSnapshot, rightSnapshot, commonTables) : undefined;
    const metadata = options.metadata ? compareMetadata(leftFile, rightFile, leftSnapshot.metadata, rightSnapshot.metadata) : undefined;
    const data = options.data ? compareTableData(leftDatabase, rightDatabase, commonTables, leftSnapshot.tables, rightSnapshot.tables) : undefined;

    return {
      left: {
        name: leftFile.name,
        size: leftFile.size,
        lastModified: leftFile.lastModified,
      },
      right: {
        name: rightFile.name,
        size: rightFile.size,
        lastModified: rightFile.lastModified,
      },
      summary: {
        schemaDifferences: schema ? schema.tablesOnlyInLeft.length + schema.tablesOnlyInRight.length + schema.tableDiffs.length + schema.viewDiffs.length : 0,
        metadataDifferences: metadata ? metadata.differences.filter((difference) => difference.status === 'different').length : 0,
        dataDifferences: data
          ? data.tableDiffs.reduce(
              (count, diff) => count + diff.onlyInLeftCount + diff.onlyInRightCount + diff.changedCount,
              0,
            )
          : 0,
        commonTables: commonTables.length,
      },
      schema,
      metadata,
      data,
    };
  } finally {
    leftDatabase.close();
    rightDatabase.close();
  }
}

function snapshotDatabase(database: SqliteDatabase): DatabaseSnapshot {
  const tableObjects = queryRows<{ name: string; sql: string | null }>(
    database,
    `
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE '${INTERNAL_TABLE_PREFIX}%'
      ORDER BY name
    `,
  );
  const viewObjects = queryRows<{ name: string; sql: string | null }>(
    database,
    `
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'view' AND name NOT LIKE '${INTERNAL_TABLE_PREFIX}%'
      ORDER BY name
    `,
  );

  const tables = Object.fromEntries(
    tableObjects.map((table) => {
      const columns = queryRows<{
        name: string;
        type: string | null;
        notnull: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }>(database, `PRAGMA table_xinfo(${quoteLiteral(table.name)})`).map((column) => ({
        name: column.name,
        type: column.type ?? '',
        notNull: Boolean(column.notnull),
        defaultValue: column.dflt_value,
        primaryKeyPosition: Number(column.pk),
        hidden: Number(column.hidden),
      }));

      const indexes = queryRows<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>(database, `PRAGMA index_list(${quoteLiteral(table.name)})`).map((index) => {
        const indexColumns = queryRows<{
          seqno: number;
          cid: number;
          name: string | null;
          key: number;
        }>(database, `PRAGMA index_xinfo(${quoteLiteral(index.name)})`)
          .filter((column) => Number(column.key) === 1)
          .map((column) => column.name ?? `expr#${column.seqno}`);

        return {
          name: index.name,
          unique: Boolean(index.unique),
          origin: index.origin,
          partial: Boolean(index.partial),
          columns: indexColumns,
        } satisfies TableIndex;
      });

      const foreignKeys = queryRows<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>(database, `PRAGMA foreign_key_list(${quoteLiteral(table.name)})`).map((foreignKey) => ({
        id: Number(foreignKey.id),
        seq: Number(foreignKey.seq),
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
        match: foreignKey.match,
      }));

      return [
        table.name,
        {
          name: table.name,
          definitionSql: table.sql ?? '',
          columns,
          indexes,
          foreignKeys,
        } satisfies TableSnapshot,
      ];
    }),
  );

  const metadata = buildMetadata(database, tableObjects.length, viewObjects.length);
  const views = Object.fromEntries(viewObjects.map((view) => [view.name, normalizeSql(view.sql ?? '')]));

  return {
    metadata,
    tables,
    tableNames: tableObjects.map((table) => table.name),
    views,
  };
}

function compareSchema(left: DatabaseSnapshot, right: DatabaseSnapshot, commonTables: string[]) {
  const tablesOnlyInLeft = left.tableNames.filter((tableName) => !right.tables[tableName]);
  const tablesOnlyInRight = right.tableNames.filter((tableName) => !left.tables[tableName]);

  const tableDiffs = commonTables
    .map((tableName) => compareTableSchema(tableName, left.tables[tableName], right.tables[tableName]))
    .filter((diff): diff is SchemaTableDiff => diff !== null);

  const leftViewNames = Object.keys(left.views);
  const rightViewNames = Object.keys(right.views);
  const viewNames = new Set([...leftViewNames, ...rightViewNames]);
  const viewDiffs = Array.from(viewNames)
    .map((name) => {
      const leftView = left.views[name];
      const rightView = right.views[name];

      if (!leftView) {
        return { name, status: 'only-right' } as const;
      }

      if (!rightView) {
        return { name, status: 'only-left' } as const;
      }

      if (leftView !== rightView) {
        return { name, status: 'definition-changed' } as const;
      }

      return null;
    })
    .filter((diff): diff is NonNullable<typeof diff> => diff !== null)
    .sort((leftDiff, rightDiff) => leftDiff.name.localeCompare(rightDiff.name));

  return {
    tablesOnlyInLeft,
    tablesOnlyInRight,
    tableDiffs,
    viewDiffs,
  };
}

function compareTableSchema(tableName: string, left: TableSnapshot, right: TableSnapshot): SchemaTableDiff | null {
  const leftColumns = Object.fromEntries(left.columns.map((column) => [column.name, column]));
  const rightColumns = Object.fromEntries(right.columns.map((column) => [column.name, column]));
  const columnNames = new Set([...left.columns.map((column) => column.name), ...right.columns.map((column) => column.name)]);

  const onlyInLeft: string[] = [];
  const onlyInRight: string[] = [];
  const changedColumns: SchemaTableDiff['columns']['changed'] = [];

  for (const columnName of Array.from(columnNames).sort((leftName, rightName) => leftName.localeCompare(rightName))) {
    const leftColumn = leftColumns[columnName];
    const rightColumn = rightColumns[columnName];

    if (!leftColumn) {
      onlyInRight.push(columnName);
      continue;
    }

    if (!rightColumn) {
      onlyInLeft.push(columnName);
      continue;
    }

    const differences: string[] = [];
    if (normalizeType(leftColumn.type) !== normalizeType(rightColumn.type)) {
      differences.push('type');
    }
    if (leftColumn.notNull !== rightColumn.notNull) {
      differences.push('nullability');
    }
    if ((leftColumn.defaultValue ?? '') !== (rightColumn.defaultValue ?? '')) {
      differences.push('default');
    }
    if (leftColumn.primaryKeyPosition !== rightColumn.primaryKeyPosition) {
      differences.push('primary key');
    }
    if (leftColumn.hidden !== rightColumn.hidden) {
      differences.push('hidden flag');
    }

    if (differences.length > 0) {
      changedColumns.push({
        columnName,
        differences,
        leftSignature: describeColumn(leftColumn),
        rightSignature: describeColumn(rightColumn),
      });
    }
  }

  const indexDiff = compareSignatures(
    left.indexes.map((index) => ({ name: index.name, signature: describeIndex(index) })),
    right.indexes.map((index) => ({ name: index.name, signature: describeIndex(index) })),
  );
  const foreignKeyDiff = compareSignatureLists(left.foreignKeys.map(describeForeignKey), right.foreignKeys.map(describeForeignKey));
  const definitionChanged = normalizeSql(left.definitionSql) !== normalizeSql(right.definitionSql);

  const hasDifference =
    onlyInLeft.length > 0 ||
    onlyInRight.length > 0 ||
    changedColumns.length > 0 ||
    indexDiff.onlyInLeft.length > 0 ||
    indexDiff.onlyInRight.length > 0 ||
    indexDiff.changed.length > 0 ||
    foreignKeyDiff.onlyInLeft.length > 0 ||
    foreignKeyDiff.onlyInRight.length > 0 ||
    definitionChanged;

  if (!hasDifference) {
    return null;
  }

  const summaryParts = [
    onlyInLeft.length + onlyInRight.length > 0 ? `${onlyInLeft.length + onlyInRight.length} missing columns` : null,
    changedColumns.length > 0 ? `${changedColumns.length} changed columns` : null,
    indexDiff.onlyInLeft.length + indexDiff.onlyInRight.length + indexDiff.changed.length > 0
      ? `${indexDiff.onlyInLeft.length + indexDiff.onlyInRight.length + indexDiff.changed.length} index changes`
      : null,
    foreignKeyDiff.onlyInLeft.length + foreignKeyDiff.onlyInRight.length > 0
      ? `${foreignKeyDiff.onlyInLeft.length + foreignKeyDiff.onlyInRight.length} foreign key changes`
      : null,
    definitionChanged ? 'definition changed' : null,
  ].filter((part): part is string => Boolean(part));

  return {
    tableName,
    summary: summaryParts.join(' • '),
    definitionChanged,
    columns: {
      onlyInLeft,
      onlyInRight,
      changed: changedColumns,
    },
    indexes: indexDiff,
    foreignKeys: foreignKeyDiff,
  };
}

function compareMetadata(
  leftFile: File,
  rightFile: File,
  leftMetadata: DatabaseMetadata,
  rightMetadata: DatabaseMetadata,
) {
  const labels = [
    ['File size', String(leftFile.size), String(rightFile.size)],
    ['Last modified', new Date(leftFile.lastModified).toISOString(), new Date(rightFile.lastModified).toISOString()],
  ] satisfies Array<[string, string, string]>;

  const metadataKeys = Array.from(new Set([...Object.keys(leftMetadata), ...Object.keys(rightMetadata)])).sort((leftKey, rightKey) =>
    leftKey.localeCompare(rightKey),
  );

  const differences = [
    ...labels.map(([label, leftValue, rightValue]) => ({
      label,
      left: leftValue,
      right: rightValue,
      status: leftValue === rightValue ? 'same' : 'different',
    } satisfies MetadataDifference)),
    ...metadataKeys.map((key) => {
      const leftValue = leftMetadata[key] ?? 'n/a';
      const rightValue = rightMetadata[key] ?? 'n/a';

      return {
        label: key,
        left: leftValue,
        right: rightValue,
        status: leftValue === rightValue ? 'same' : 'different',
      } satisfies MetadataDifference;
    }),
  ];

  return { differences };
}

function compareTableData(
  leftDatabase: SqliteDatabase,
  rightDatabase: SqliteDatabase,
  commonTables: string[],
  leftTables: Record<string, TableSnapshot>,
  rightTables: Record<string, TableSnapshot>,
) {
  const tableDiffs = commonTables
    .map((tableName) => compareSingleTableData(tableName, leftDatabase, rightDatabase, leftTables[tableName], rightTables[tableName]))
    .filter((diff): diff is DataTableDiff => diff !== null);

  return { tableDiffs };
}

function compareSingleTableData(
  tableName: string,
  leftDatabase: SqliteDatabase,
  rightDatabase: SqliteDatabase,
  leftTable: TableSnapshot,
  rightTable: TableSnapshot,
): DataTableDiff | null {
  const leftColumns = leftTable.columns.map((column) => column.name);
  const rightColumns = rightTable.columns.map((column) => column.name);
  const sharedColumns = leftColumns.filter((columnName) => rightColumns.includes(columnName));
  const comparableColumns = buildComparableColumnList(leftColumns, rightColumns);
  const leftRows = normalizeRows(queryTableRows(leftDatabase, tableName, leftColumns), comparableColumns);
  const rightRows = normalizeRows(queryTableRows(rightDatabase, tableName, rightColumns), comparableColumns);
  const primaryKeyColumns = getSharedPrimaryKeyColumns(leftTable, rightTable);

  if (primaryKeyColumns.length > 0) {
    const leftMap = new Map(leftRows.map((row) => [buildRowKey(row, primaryKeyColumns), row]));
    const rightMap = new Map(rightRows.map((row) => [buildRowKey(row, primaryKeyColumns), row]));
    const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
    const onlyInLeft: RowPreview[] = [];
    const onlyInRight: RowPreview[] = [];
    const changedRows: ChangedRow[] = [];
    let onlyInLeftCount = 0;
    let onlyInRightCount = 0;
    let changedCount = 0;

    for (const key of Array.from(keys).sort((leftKey, rightKey) => leftKey.localeCompare(rightKey))) {
      const leftRow = leftMap.get(key);
      const rightRow = rightMap.get(key);

      if (leftRow && !rightRow) {
        onlyInLeftCount += 1;
        if (onlyInLeft.length < MAX_SAMPLE_ROWS) {
          onlyInLeft.push({ key, values: leftRow });
        }
        continue;
      }

      if (!leftRow && rightRow) {
        onlyInRightCount += 1;
        if (onlyInRight.length < MAX_SAMPLE_ROWS) {
          onlyInRight.push({ key, values: rightRow });
        }
        continue;
      }

      if (!leftRow || !rightRow) {
        continue;
      }

      const differingColumns = comparableColumns.filter((column) => (leftRow[column] ?? 'NULL') !== (rightRow[column] ?? 'NULL'));
      if (differingColumns.length > 0) {
        changedCount += 1;
        if (changedRows.length < MAX_SAMPLE_ROWS) {
          changedRows.push({
            key,
            keyLabel: primaryKeyColumns.join(', '),
            differingColumns,
            left: { key, values: leftRow },
            right: { key, values: rightRow },
          });
        }
      }
    }

    if (onlyInLeftCount === 0 && onlyInRightCount === 0 && changedCount === 0) {
      return null;
    }

    return {
      tableName,
      columns: comparableColumns,
      keyMode: 'primary-key',
      note:
        sharedColumns.length === 0
          ? 'No columns are shared between these table definitions. Matching rows are still aligned by primary key and missing columns are shown explicitly.'
          : undefined,
      leftRowCount: leftRows.length,
      rightRowCount: rightRows.length,
      onlyInLeftCount,
      onlyInRightCount,
      changedCount,
      onlyInLeft,
      onlyInRight,
      changedRows,
    };
  }

  const leftCounter = buildRowMultiset(leftRows, comparableColumns);
  const rightCounter = buildRowMultiset(rightRows, comparableColumns);
  const signatures = new Set([...leftCounter.keys(), ...rightCounter.keys()]);
  const onlyInLeft: RowPreview[] = [];
  const onlyInRight: RowPreview[] = [];
  let onlyInLeftCount = 0;
  let onlyInRightCount = 0;

  for (const signature of signatures) {
    const leftEntries = leftCounter.get(signature) ?? [];
    const rightEntries = rightCounter.get(signature) ?? [];
    const difference = leftEntries.length - rightEntries.length;

    if (difference > 0) {
      onlyInLeftCount += difference;
      if (onlyInLeft.length < MAX_SAMPLE_ROWS) {
        onlyInLeft.push(...leftEntries.slice(0, Math.min(difference, MAX_SAMPLE_ROWS - onlyInLeft.length)));
      }
    }

    if (difference < 0) {
      onlyInRightCount += Math.abs(difference);
      if (onlyInRight.length < MAX_SAMPLE_ROWS) {
        onlyInRight.push(...rightEntries.slice(0, Math.min(Math.abs(difference), MAX_SAMPLE_ROWS - onlyInRight.length)));
      }
    }
  }

  if (onlyInLeftCount === 0 && onlyInRightCount === 0) {
    return null;
  }

  return {
    tableName,
    columns: comparableColumns,
    keyMode: 'full-row',
    note:
      sharedColumns.length === 0
        ? 'These tables share no column names and no shared primary key, so every row is compared as a full-row snapshot with missing columns shown explicitly.'
        : 'This table has no shared primary key definition, so differences are shown as unmatched full rows.',
    leftRowCount: leftRows.length,
    rightRowCount: rightRows.length,
    onlyInLeftCount,
    onlyInRightCount,
    changedCount: 0,
    onlyInLeft,
    onlyInRight,
    changedRows: [],
  };
}

function buildMetadata(database: SqliteDatabase, tableCount: number, viewCount: number): DatabaseMetadata {
  const metadataEntries: Array<[string, string]> = [
    ['Table count', String(tableCount)],
    ['View count', String(viewCount)],
    ['Index count', readScalar(database, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name NOT LIKE '${INTERNAL_TABLE_PREFIX}%'`)],
    ['Trigger count', readScalar(database, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'`)],
    ['Page count', readPragmaScalar(database, 'page_count')],
    ['Freelist count', readPragmaScalar(database, 'freelist_count')],
    ['Encoding', readPragmaScalar(database, 'encoding')],
    ['Journal mode', readPragmaScalar(database, 'journal_mode')],
    ['Auto vacuum', readPragmaScalar(database, 'auto_vacuum')],
    ['User version', readPragmaScalar(database, 'user_version')],
    ['Application id', readPragmaScalar(database, 'application_id')],
    ['Schema version', readPragmaScalar(database, 'schema_version')],
    ['SQLite version', readScalar(database, 'SELECT sqlite_version()')],
  ];

  return Object.fromEntries(metadataEntries);
}

function queryTableRows(database: SqliteDatabase, tableName: string, columns: string[]) {
  const orderedPrimaryKeys = queryRows<{
    name: string;
    pk: number;
  }>(database, `PRAGMA table_xinfo(${quoteLiteral(tableName)})`)
    .filter((column) => Number(column.pk) > 0)
    .sort((leftColumn, rightColumn) => Number(leftColumn.pk) - Number(rightColumn.pk))
    .map((column) => column.name)
    .filter((columnName) => columns.includes(columnName));

  const orderBy = orderedPrimaryKeys.length > 0 ? ` ORDER BY ${orderedPrimaryKeys.map(quoteIdentifier).join(', ')}` : '';
  const statement = database.prepare(
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(tableName)}${orderBy}`,
  );
  const rows: Array<Record<string, string>> = [];

  try {
    while (statement.step()) {
      const rawRow = statement.getAsObject() as Record<string, SqliteValue>;
      rows.push(
        Object.fromEntries(columns.map((column) => [column, formatCellValue(rawRow[column] ?? null)])),
      );
    }
  } finally {
    statement.free();
  }

  return rows;
}

function queryRows<Row extends Record<string, SqliteValue>>(database: SqliteDatabase, sql: string): Row[] {
  const statement = database.prepare(sql);
  const rows: Row[] = [];

  try {
    while (statement.step()) {
      rows.push(statement.getAsObject() as Row);
    }
  } finally {
    statement.free();
  }

  return rows;
}

function readScalar(database: SqliteDatabase, sql: string) {
  const statement = database.prepare(sql);

  try {
    if (!statement.step()) {
      return 'n/a';
    }

    const value = statement.get()[0] as SqliteValue;
    return formatCellValue(value);
  } finally {
    statement.free();
  }
}

function readPragmaScalar(database: SqliteDatabase, pragmaName: string) {
  const rows = database.exec(`PRAGMA ${pragmaName}`);
  if (rows.length === 0 || rows[0].values.length === 0 || rows[0].values[0].length === 0) {
    return 'n/a';
  }

  return formatCellValue(rows[0].values[0][0] as SqliteValue);
}

function getSharedPrimaryKeyColumns(left: TableSnapshot, right: TableSnapshot) {
  const leftPrimaryKey = left.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((leftColumn, rightColumn) => leftColumn.primaryKeyPosition - rightColumn.primaryKeyPosition)
    .map((column) => column.name);
  const rightPrimaryKey = right.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((leftColumn, rightColumn) => leftColumn.primaryKeyPosition - rightColumn.primaryKeyPosition)
    .map((column) => column.name);

  return leftPrimaryKey.length > 0 && leftPrimaryKey.join('|') === rightPrimaryKey.join('|') ? leftPrimaryKey : [];
}

function buildRowKey(row: Record<string, string>, keyColumns: string[]) {
  return keyColumns.map((column) => `${column}=${row[column] ?? 'NULL'}`).join(' | ');
}

function buildRowMultiset(rows: Array<Record<string, string>>, columns: string[]) {
  const multiset = new Map<string, RowPreview[]>();

  for (const row of rows) {
    const signature = columns.map((column) => `${column}:${row[column] ?? 'NULL'}`).join('||');
    const collection = multiset.get(signature) ?? [];
    collection.push({
      key: signature,
      values: row,
    });
    multiset.set(signature, collection);
  }

  return multiset;
}

function buildComparableColumnList(leftColumns: string[], rightColumns: string[]) {
  return [...leftColumns, ...rightColumns.filter((column) => !leftColumns.includes(column))];
}

function normalizeRows(rows: Array<Record<string, string>>, comparableColumns: string[]) {
  return rows.map((row) =>
    Object.fromEntries(
      comparableColumns.map((column) => [column, Object.prototype.hasOwnProperty.call(row, column) ? row[column] : ABSENT_VALUE]),
    ),
  );
}

function compareSignatures(
  left: Array<{ name: string; signature: string }>,
  right: Array<{ name: string; signature: string }>,
) {
  const leftMap = Object.fromEntries(left.map((entry) => [entry.name, entry.signature]));
  const rightMap = Object.fromEntries(right.map((entry) => [entry.name, entry.signature]));
  const names = new Set([...left.map((entry) => entry.name), ...right.map((entry) => entry.name)]);
  const onlyInLeft: string[] = [];
  const onlyInRight: string[] = [];
  const changed: string[] = [];

  for (const name of Array.from(names).sort((leftName, rightName) => leftName.localeCompare(rightName))) {
    const leftSignature = leftMap[name];
    const rightSignature = rightMap[name];

    if (!leftSignature) {
      onlyInRight.push(name);
      continue;
    }

    if (!rightSignature) {
      onlyInLeft.push(name);
      continue;
    }

    if (leftSignature !== rightSignature) {
      changed.push(name);
    }
  }

  return {
    onlyInLeft,
    onlyInRight,
    changed,
  };
}

function compareSignatureLists(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  return {
    onlyInLeft: left.filter((signature) => !rightSet.has(signature)),
    onlyInRight: right.filter((signature) => !leftSet.has(signature)),
  };
}

function describeColumn(column: TableColumn) {
  return [
    column.name,
    normalizeType(column.type) || 'no type',
    column.notNull ? 'NOT NULL' : 'NULLABLE',
    column.defaultValue ? `DEFAULT ${column.defaultValue}` : 'NO DEFAULT',
    column.primaryKeyPosition > 0 ? `PK ${column.primaryKeyPosition}` : 'NOT PK',
    column.hidden > 0 ? `HIDDEN ${column.hidden}` : 'VISIBLE',
  ].join(' • ');
}

function describeIndex(index: TableIndex) {
  return `${index.unique ? 'UNIQUE' : 'INDEX'} ${index.origin} (${index.columns.join(', ')})${index.partial ? ' WHERE ...' : ''}`;
}

function describeForeignKey(foreignKey: ForeignKey) {
  return `${foreignKey.id}:${foreignKey.from}->${foreignKey.table}.${foreignKey.to} [${foreignKey.onUpdate}/${foreignKey.onDelete}/${foreignKey.match}]`;
}

function normalizeType(type: string) {
  return type.trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeSql(sql: string) {
  return sql.trim().replace(/\s+/g, ' ').toUpperCase();
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function formatCellValue(value: SqliteValue) {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}` : value.toString();
  }

  if (typeof value === 'string') {
    return value;
  }

  return `0x${Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}