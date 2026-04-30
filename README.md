# SQLite Diff

SQLite Diff is a frontend-only web app for comparing two SQLite database files directly in the browser. It uses React, Vite, TypeScript, and `sql.js` WebAssembly to inspect schema differences, selected metadata, and row-level data changes without uploading the databases to a server.

## What It Does

- Compares schema by default, including tables, columns, indexes, foreign keys, and views.
- Optionally compares metadata such as file details and selected SQLite pragma values.
- Optionally compares table data and highlights rows that only exist on one side or have changed values.
- Runs fully client-side, so database files stay on the local machine.

## Local Deployment

### Prerequisites

- Node.js 20 or newer
- npm

### Run Locally

Install dependencies:

```bash
npm install
```

Start the local development server:

```bash
npm run dev
```

Vite will print a local URL, typically `http://localhost:5173`.

### Build For Local Preview

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## GitHub Pages Deployment

This repository includes a GitHub Actions workflow that builds the site and pushes the generated `dist` output to the `gh-pages` branch.

Expected setup:

- Your default branch is the source branch for the workflow.
- GitHub Pages is configured to serve from the `gh-pages` branch.
- The workflow has permission to write to repository contents.

The workflow also sets the Vite base path automatically from the repository name so static assets resolve correctly on GitHub Pages project sites.