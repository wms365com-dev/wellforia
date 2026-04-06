# Wellforia

Standalone pallet position storage calculator for converting actual 60-inch rack usage into 72-inch billable pallet positions.

## Run locally

```bash
npm start
```

Then open `http://localhost:3000`.

## Deploy on Railway

1. Push this repo to GitHub.
2. Create a Railway project from the GitHub repository.
3. Add a Railway `PostgreSQL` service to the same project.
4. Confirm the web service has a `DATABASE_URL` variable from the PostgreSQL service reference.
5. Railway can run the app with the included `npm start` command.
6. The app exposes a simple health endpoint at `/health`.

## Shared Data Storage

- The web app now supports shared save/load through Railway PostgreSQL at `/api/state`.
- Data is stored in mapped tables for `app_config`, `item_master_rows`, `stock_rows`, and `calculator_rows`.
- The server also rebuilds mapped calculator rows from item master plus stock rows when needed.
- If `DATABASE_URL` is missing, the app still runs, but shared Railway saving is disabled and browser `Save Local` remains available.
