import { startTransition, useDeferredValue, useEffect, useState } from 'react';
import {
  compareSqliteFiles,
  getSqlJs,
  type ChangedRow,
  type CompareOptions,
  type CompareResult,
  type DataTableDiff,
  type MetadataDifference,
  type RowPreview,
  type SchemaTableDiff,
} from './lib/sqliteCompare';

const defaultOptions: CompareOptions = {
  schema: true,
  metadata: false,
  data: false,
};

const DEFAULT_RENDERED_DIFF_ROWS = 20;

const numberFormatter = new Intl.NumberFormat();

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function FileDropzone({
  title,
  accent,
  file,
  onFileChange,
}: {
  title: string;
  accent: 'left' | 'right';
  file: File | null;
  onFileChange: (file: File | null) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);

  return (
    <label
      className={`dropzone dropzone--${accent} ${isDragging ? 'is-dragging' : ''}`}
      onDragEnter={() => setIsDragging(true)}
      onDragLeave={() => setIsDragging(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        const [droppedFile] = Array.from(event.dataTransfer.files);
        onFileChange(droppedFile ?? null);
      }}
    >
      <input
        type="file"
        accept=".db,.sqlite,.sqlite3,.db3,.s3db,application/vnd.sqlite3,application/octet-stream"
        onChange={(event) => {
          const [selectedFile] = Array.from(event.target.files ?? []);
          onFileChange(selectedFile ?? null);
        }}
      />
      <div className="dropzone__eyebrow">{title}</div>
      <div className="dropzone__title">Drop a SQLite file here</div>
      <div className="dropzone__subtitle">or browse from disk</div>

      {file ? (
        <div className="dropzone__meta">
          <strong>{file.name}</strong>
          <span>{formatBytes(file.size)}</span>
          <span>{formatDate(file.lastModified)}</span>
          <button
            type="button"
            className="ghost-button"
            onClick={(event) => {
              event.preventDefault();
              onFileChange(null);
            }}
          >
            Clear
          </button>
        </div>
      ) : (
        <div className="dropzone__hint">Supports `.db`, `.sqlite`, `.sqlite3` and related file extensions.</div>
      )}
    </label>
  );
}

function OptionToggle({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={`option-toggle ${checked ? 'is-active' : ''}`} onClick={onToggle}>
      <span>{label}</span>
      <small>{description}</small>
    </button>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'default' | 'warn' | 'accent' }) {
  return (
    <div className={`summary-card ${tone ? `summary-card--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KeyValueRow({ difference }: { difference: MetadataDifference }) {
  return (
    <div className={`metadata-row ${difference.status !== 'same' ? 'is-different' : ''}`}>
      <div>
        <span>{difference.label}</span>
        <small>{difference.status === 'same' ? 'match' : 'different'}</small>
      </div>
      <code>{difference.left}</code>
      <code>{difference.right}</code>
    </div>
  );
}

function RowPreviewTable({
  title,
  rows,
  columns,
  totalCount,
}: {
  title: string;
  rows: RowPreview[];
  columns: string[];
  totalCount: number;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="table-panel">
      <div className="table-panel__header">
        <h4>{title}</h4>
        <span>
          {rows.length === totalCount
            ? `${numberFormatter.format(totalCount)} rows`
            : `${numberFormatter.format(rows.length)} of ${numberFormatter.format(totalCount)} rows shown`}
        </span>
      </div>
      <div className="grid-table-wrapper">
        <table className="grid-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${title}-${row.key}-${index}`}>
                {columns.map((column) => (
                  <td key={column}>{row.values[column] ?? 'NULL'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChangedRowsTable({
  rows,
  columns,
  totalCount,
}: {
  rows: ChangedRow[];
  columns: string[];
  totalCount: number;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="table-panel">
      <div className="table-panel__header">
        <h4>Changed rows</h4>
        <span>
          {rows.length === totalCount
            ? `${numberFormatter.format(totalCount)} rows`
            : `${numberFormatter.format(rows.length)} of ${numberFormatter.format(totalCount)} rows shown`}
        </span>
      </div>
      <div className="changed-row-list">
        {rows.map((row, index) => (
          <div key={`${row.key}-${index}`} className="changed-row-card">
            <div className="changed-row-card__header">
              <strong>{row.keyLabel}</strong>
              <span>{row.key}</span>
            </div>
            <div className="changed-row-card__columns">
              {row.differingColumns.map((column) => (
                <article key={column}>
                  <span>{column}</span>
                  <div>
                    <code>{row.left.values[column] ?? 'NULL'}</code>
                    <code>{row.right.values[column] ?? 'NULL'}</code>
                  </div>
                </article>
              ))}
            </div>
            <details>
              <summary>View full row</summary>
              <div className="grid-table-wrapper">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Left</th>
                      <th>Right</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((column) => (
                      <tr key={column}>
                        <td>{column}</td>
                        <td>{row.left.values[column] ?? 'NULL'}</td>
                        <td>{row.right.values[column] ?? 'NULL'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

function SchemaDiffCard({ diff }: { diff: SchemaTableDiff }) {
  return (
    <details className="result-card" open>
      <summary>
        <div className="result-card__summary-text result-card__summary-text--inline">
          <strong>{diff.tableName}</strong>
          <span>{diff.summary}</span>
        </div>
      </summary>

      <div className="result-card__content">
        {diff.columns.onlyInLeft.length > 0 || diff.columns.onlyInRight.length > 0 ? (
          <div className="pill-group">
            {diff.columns.onlyInLeft.map((column) => (
              <span key={`left-${column}`} className="pill pill--left">Only left: {column}</span>
            ))}
            {diff.columns.onlyInRight.map((column) => (
              <span key={`right-${column}`} className="pill pill--right">Only right: {column}</span>
            ))}
          </div>
        ) : null}

        {diff.columns.changed.length > 0 ? (
          <div className="schema-grid">
            {diff.columns.changed.map((column) => (
              <article key={column.columnName} className="schema-change-card">
                <div className="schema-change-card__header">
                  <h4>{column.columnName}</h4>
                  <div className="pill-group">
                    {column.differences.map((difference) => (
                      <span key={difference} className="pill pill--warn">{difference}</span>
                    ))}
                  </div>
                </div>
                <div className="schema-signature-grid">
                  <div className="schema-signature-block">
                    <span>Left</span>
                    <code>{column.leftSignature}</code>
                  </div>
                  <div className="schema-signature-block">
                    <span>Right</span>
                    <code>{column.rightSignature}</code>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {diff.indexes.onlyInLeft.length > 0 || diff.indexes.onlyInRight.length > 0 || diff.indexes.changed.length > 0 ? (
          <section>
            <h4>Indexes</h4>
            <div className="pill-group">
              {diff.indexes.onlyInLeft.map((name) => (
                <span key={`index-left-${name}`} className="pill pill--left">Only left: {name}</span>
              ))}
              {diff.indexes.onlyInRight.map((name) => (
                <span key={`index-right-${name}`} className="pill pill--right">Only right: {name}</span>
              ))}
              {diff.indexes.changed.map((name) => (
                <span key={`index-changed-${name}`} className="pill pill--warn">Changed: {name}</span>
              ))}
            </div>
          </section>
        ) : null}

        {diff.foreignKeys.onlyInLeft.length > 0 || diff.foreignKeys.onlyInRight.length > 0 ? (
          <section>
            <h4>Foreign keys</h4>
            <div className="pill-group">
              {diff.foreignKeys.onlyInLeft.map((signature) => (
                <span key={`fk-left-${signature}`} className="pill pill--left">Only left: {signature}</span>
              ))}
              {diff.foreignKeys.onlyInRight.map((signature) => (
                <span key={`fk-right-${signature}`} className="pill pill--right">Only right: {signature}</span>
              ))}
            </div>
          </section>
        ) : null}

        {diff.definitionChanged ? <p className="callout">CREATE statement text differs between databases.</p> : null}
      </div>
    </details>
  );
}

function DataDiffCard({ diff }: { diff: DataTableDiff }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const keyModeLabel =
    diff.keyMode === 'primary-key'
      ? 'primary key'
      : diff.keyMode === 'unique-index'
        ? 'unique index'
        : diff.keyMode === 'row-order'
          ? 'row position'
          : 'full-row snapshot';
    const totalRenderableRows = diff.changedRows.length + diff.onlyInLeft.length + diff.onlyInRight.length;
    const shouldShowExpand = totalRenderableRows > DEFAULT_RENDERED_DIFF_ROWS;

    let remainingRows = isExpanded ? Number.POSITIVE_INFINITY : DEFAULT_RENDERED_DIFF_ROWS;
    const visibleChangedRows = diff.changedRows.slice(0, remainingRows);
    remainingRows = Number.isFinite(remainingRows) ? Math.max(0, remainingRows - visibleChangedRows.length) : remainingRows;
    const visibleOnlyInLeft = diff.onlyInLeft.slice(0, remainingRows);
    remainingRows = Number.isFinite(remainingRows) ? Math.max(0, remainingRows - visibleOnlyInLeft.length) : remainingRows;
    const visibleOnlyInRight = diff.onlyInRight.slice(0, remainingRows);
    const visibleRenderedRows = visibleChangedRows.length + visibleOnlyInLeft.length + visibleOnlyInRight.length;

  return (
    <details className="result-card" open>
      <summary>
        <div className="result-card__summary-text result-card__summary-text--inline">
          <strong>{diff.tableName}</strong>
          <span>
            {numberFormatter.format(diff.onlyInLeftCount)} left-only • {numberFormatter.format(diff.onlyInRightCount)} right-only •{' '}
            {numberFormatter.format(diff.changedCount)} changed
          </span>
        </div>
      </summary>

      <div className="result-card__content">
        <div className="result-card__toolbar">
          <div className="stat-inline-row">
            <span>Match mode: {keyModeLabel}</span>
            <span>Match key: {diff.keyLabel}</span>
            <span>Left rows: {numberFormatter.format(diff.leftRowCount)}</span>
            <span>Right rows: {numberFormatter.format(diff.rightRowCount)}</span>
            <span>
              Showing {numberFormatter.format(visibleRenderedRows)} of {numberFormatter.format(totalRenderableRows)} diff rows
            </span>
          </div>
        </div>

        {diff.note ? <p className="callout">{diff.note}</p> : null}

        <ChangedRowsTable rows={visibleChangedRows} columns={diff.columns} totalCount={diff.changedRows.length} />
        <RowPreviewTable title="Rows only in left" rows={visibleOnlyInLeft} columns={diff.columns} totalCount={diff.onlyInLeft.length} />
        <RowPreviewTable title="Rows only in right" rows={visibleOnlyInRight} columns={diff.columns} totalCount={diff.onlyInRight.length} />

        {shouldShowExpand ? (
          <div className="result-card__footer-action">
            <button
              type="button"
              className="icon-button"
              aria-label={isExpanded ? 'Collapse table differences' : 'Expand table differences'}
              title={isExpanded ? 'Collapse table differences' : 'Expand table differences'}
              onClick={() => setIsExpanded((current) => !current)}
            >
              {isExpanded ? '^' : 'v'}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default function App() {
  const [leftFile, setLeftFile] = useState<File | null>(null);
  const [rightFile, setRightFile] = useState<File | null>(null);
  const [options, setOptions] = useState<CompareOptions>(defaultOptions);
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deferredComparison = useDeferredValue(comparison);

  useEffect(() => {
    let cancelled = false;

    void getSqlJs()
      .then(() => {
        if (!cancelled) {
          setRuntimeReady(true);
        }
      })
      .catch((runtimeError: unknown) => {
        if (!cancelled) {
          setError(runtimeError instanceof Error ? runtimeError.message : 'Unable to initialize SQLite runtime.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleOption = (key: keyof CompareOptions) => {
    setOptions((currentOptions) => {
      const selectedOptionCount = Object.values(currentOptions).filter(Boolean).length;

      if (currentOptions[key] && selectedOptionCount === 1) {
        return currentOptions;
      }

      return {
        ...currentOptions,
        [key]: !currentOptions[key],
      };
    });
  };

  const canCompare = Boolean(leftFile && rightFile && runtimeReady && !loading);

  const handleCompare = async () => {
    if (!leftFile || !rightFile) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await compareSqliteFiles(leftFile, rightFile, options);

      startTransition(() => {
        setComparison(result);
      });
    } catch (compareError: unknown) {
      setError(compareError instanceof Error ? compareError.message : 'Comparison failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <main className="app-layout">
        <section className="hero-card">
          <div className="hero-copy">
            <span className="hero-copy__eyebrow">Frontend-only SQLite diffing</span>
            <h1>Inspect two databases entirely in the browser.</h1>
            <p>
              Compare schema, metadata and row-level data with a WebAssembly-backed SQLite engine. Nothing leaves the page.
            </p>
          </div>

          <div className="hero-badges">
            <span>WASM runtime</span>
            <span>Schema-first workflow</span>
            <span>No server</span>
          </div>
        </section>

        <section className="upload-grid">
          <FileDropzone title="Left database" accent="left" file={leftFile} onFileChange={setLeftFile} />
          <FileDropzone title="Right database" accent="right" file={rightFile} onFileChange={setRightFile} />
        </section>

        <section className="control-bar">
          <div>
            <span className="section-label">Compare</span>
            <div className="option-grid">
              <OptionToggle
                label="Schema"
                description="Tables, columns, indexes, foreign keys"
                checked={options.schema}
                onToggle={() => toggleOption('schema')}
              />
              <OptionToggle
                label="Metadata"
                description="File stats, pragmas and object counts"
                checked={options.metadata}
                onToggle={() => toggleOption('metadata')}
              />
              <OptionToggle
                label="Data"
                description="Row-level differences across shared tables"
                checked={options.data}
                onToggle={() => toggleOption('data')}
              />
            </div>
          </div>

          <div className="control-bar__actions">
            <div className="runtime-pill">
              <span className={runtimeReady ? 'is-ready' : ''} />
              {runtimeReady ? 'SQLite runtime ready' : 'Loading SQLite runtime'}
            </div>
            <button type="button" className="compare-button" disabled={!canCompare} onClick={() => void handleCompare()}>
              {loading ? 'Comparing…' : 'Run comparison'}
            </button>
          </div>
        </section>

        {error ? <section className="feedback-banner feedback-banner--error">{error}</section> : null}

        {deferredComparison ? (
          <>
            <section className="summary-grid">
              <SummaryCard label="Schema differences" value={numberFormatter.format(deferredComparison.summary.schemaDifferences)} tone="warn" />
              <SummaryCard label="Metadata differences" value={numberFormatter.format(deferredComparison.summary.metadataDifferences)} />
              <SummaryCard label="Data differences" value={numberFormatter.format(deferredComparison.summary.dataDifferences)} tone="accent" />
              <SummaryCard label="Common tables" value={numberFormatter.format(deferredComparison.summary.commonTables)} />
            </section>

            {deferredComparison.schema ? (
              <section className="content-section">
                <div className="content-section__header">
                  <div>
                    <span className="section-label">Schema</span>
                    <h2>Structural differences</h2>
                  </div>
                  <p>Default mode focuses on objects and definitions before touching table data.</p>
                </div>

                <div className="schema-overview-grid">
                  <article className="result-card result-card--static">
                    <h3>Tables only in {deferredComparison.left.name}</h3>
                    <div className="pill-group">
                      {deferredComparison.schema.tablesOnlyInLeft.length > 0 ? deferredComparison.schema.tablesOnlyInLeft.map((name) => (
                        <span key={name} className="pill pill--left">{name}</span>
                      )) : <span className="pill">None</span>}
                    </div>
                  </article>
                  <article className="result-card result-card--static">
                    <h3>Tables only in {deferredComparison.right.name}</h3>
                    <div className="pill-group">
                      {deferredComparison.schema.tablesOnlyInRight.length > 0 ? deferredComparison.schema.tablesOnlyInRight.map((name) => (
                        <span key={name} className="pill pill--right">{name}</span>
                      )) : <span className="pill">None</span>}
                    </div>
                  </article>
                </div>

                {deferredComparison.schema.tableDiffs.length > 0 ? deferredComparison.schema.tableDiffs.map((diff) => (
                  <SchemaDiffCard key={diff.tableName} diff={diff} />
                )) : <article className="result-card result-card--static"><h3>No schema differences detected</h3></article>}

                {deferredComparison.schema.viewDiffs.length > 0 ? (
                  <article className="result-card result-card--static">
                    <h3>View differences</h3>
                    <div className="pill-group">
                      {deferredComparison.schema.viewDiffs.map((view) => (
                        <span key={view.name} className="pill pill--warn">{view.name}: {view.status}</span>
                      ))}
                    </div>
                  </article>
                ) : null}
              </section>
            ) : null}

            {deferredComparison.metadata ? (
              <section className="content-section">
                <div className="content-section__header">
                  <div>
                    <span className="section-label">Metadata</span>
                    <h2>File and pragma comparison</h2>
                  </div>
                  <p>Includes file size, timestamps, schema versions and selected SQLite pragma values.</p>
                </div>

                <article className="result-card result-card--static">
                  <div className="metadata-grid metadata-grid--head">
                    <span>Property</span>
                    <span>{deferredComparison.left.name}</span>
                    <span>{deferredComparison.right.name}</span>
                  </div>
                  {deferredComparison.metadata.differences.map((difference) => (
                    <KeyValueRow key={difference.label} difference={difference} />
                  ))}
                </article>
              </section>
            ) : null}

            {deferredComparison.data ? (
              <section className="content-section">
                <div className="content-section__header">
                  <div>
                    <span className="section-label">Data</span>
                    <h2>Row-level changes</h2>
                  </div>
                  <p>
                    Shared tables are compared by primary key when available. Tables without a primary key fall back to full-row matching.
                  </p>
                </div>

                {deferredComparison.data.tableDiffs.length > 0 ? deferredComparison.data.tableDiffs.map((diff) => (
                  <DataDiffCard key={diff.tableName} diff={diff} />
                )) : <article className="result-card result-card--static"><h3>No data differences detected in shared tables</h3></article>}
              </section>
            ) : null}
          </>
        ) : (
          <section className="empty-state">
            <span className="section-label">Ready</span>
            <h2>Load two databases and run the comparison.</h2>
            <p>
              Schema comparison is enabled by default. Turn on metadata or data when you want deeper inspection.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}