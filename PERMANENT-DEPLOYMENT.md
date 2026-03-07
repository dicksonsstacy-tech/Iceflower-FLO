# Permanent Deployment Setup

## Architecture
- Frontend: Vercel (`my-react-app`)
- Backend + trading engine: Render (`backend`)
- Rule: no live trading logic on Vercel serverless functions

## 1) Deploy Backend on Render
- Create a Render Web Service from this repo using `render.yaml`.
- Root directory: `backend`.
- Set required secrets in Render:
- `DERIV_APP_ID`
- `DERIV_TOKEN`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS` (example: `https://your-vercel-app.vercel.app`)

The repo defaults already set:
- `AUTO_START_TRADER=true`
- `MAX_STAKE_PER_TRADE=0.35`
- `MIN_PROFIT_TARGET=0.02`
- `MAX_DAILY_LOSS=0.20`
- `CONFIDENCE_THRESHOLD=0.90`
- `MAX_CONCURRENT_TRADES=1`
- `MAX_CONSECUTIVE_LOSSES=3`
- `MAX_PENDING_TRADE_AGE_MS=180000`

## 2) Deploy Frontend on Vercel
- Import repo on Vercel.
- Framework root: project root (uses `vercel.json` static build).
- Add env var on Vercel:
- `VITE_BACKEND_URL=https://<your-render-service>.onrender.com`

## 3) Verify After Deploy
- Backend health:
- `GET https://<render-url>/api/health`
- Frontend opens and calls Render API successfully.
- Press `Start Auto Trader 24/7` once from UI to confirm manual control.
- Confirm auto-start behavior by restarting Render service and checking `/api/retirement/stats`.
- Verify audit trail endpoint (admin): `GET /api/admin/trading/audit`.
- Verify phase readiness endpoint (admin): `GET /api/admin/trading/readiness`.

## 4) Operating Rules (for small balance)
- Keep `MAX_CONCURRENT_TRADES=1`.
- Keep `MAX_DAILY_LOSS` very low.
- Do not raise stake limits until demo performance is stable over many sessions.
