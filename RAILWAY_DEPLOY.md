# Deploy to Railway

This project is ready to deploy on Railway using the included Dockerfile.

## 1) Push backend to GitHub

Push the `backend-kami` folder to a repository.

## 2) Create Railway project

1. Open Railway dashboard.
2. Click `New Project`.
3. Choose `Deploy from GitHub repo`.
4. Select your backend repository (or monorepo service root for `backend-kami`).

Railway will detect the Dockerfile and build from it.

## 3) Configure service variables

Set these env vars in Railway service settings:

- `PORT=3000`
- `SCRAPER_PROXY_URL` (optional, global fallback for all providers)
- `MANHWAONLINE_PROXY_URL` (optional, recommended if only manhwa-online needs proxy)

Proxy format:

`http://user:pass@host:port`

## 4) Deploy and verify

After deployment:

1. Open service URL.
2. Test:
   - `/`
   - `/latest`
   - `/latest/health`

Expected health output includes source diagnostics for:

- `zonatmo`
- `visormanga`
- `manhwaonline`

## 5) Connect app

In your mobile app, point backend base URL to your Railway URL.

## Notes

- Keep diagnostics endpoint enabled to monitor source status in production.
