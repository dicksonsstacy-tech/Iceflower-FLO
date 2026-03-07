# 24/7 Production Deployment (Render)

This is the recommended production host for this repo because your backend already targets Render with a persistent process model and health checks.

## Why this setup
- Always-on paid instance (`plan: standard`) for 24/7 loop execution.
- Persistent disk at `/data` for audit ledger durability across restarts/deploys.
- Admin-gated control plane and risk endpoints for operations evidence.

## 1) Deploy backend from `render.yaml`
1. In Render, create a **Blueprint** from this repo.
2. Confirm service `iceflower-flo-backend` is created.
3. Verify the service has:
- `plan: standard`
- Disk mounted at `/data`
- Health check: `/api/health`

## 2) Set required environment variables on Render
Required:
- `DERIV_APP_ID`
- `DERIV_TOKEN`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS` (your frontend origin, e.g. `https://<your-vercel-app>.vercel.app`)

Recommended:
- `ML_PREDICT_URL` (your live ML service `/predict` endpoint)

Already configured by `render.yaml`:
- `TRADE_LEDGER_PATH=/data/trade-ledger.ndjson`
- `AUTO_START_TRADER=true`
- Risk controls (`MAX_*`)

## 3) Deploy frontend
Use Vercel for `my-react-app` and set:
- `VITE_BACKEND_URL=https://<your-render-backend>.onrender.com`

## 4) Production verification checklist
Run after login (use admin token):

1. Health check:
```bash
curl https://<render-backend>/api/health
```

2. Start trader:
```bash
curl -X POST https://<render-backend>/api/retirement/start -H "Authorization: Bearer <ADMIN_TOKEN>"
```

3. Runtime stats:
```bash
curl https://<render-backend>/api/retirement/stats
```

4. Audit stream:
```bash
curl "https://<render-backend>/api/admin/trading/audit?limit=20" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

5. 24h summary:
```bash
curl "https://<render-backend>/api/admin/trading/summary?hours=24" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

6. Readiness report:
```bash
curl https://<render-backend>/api/admin/trading/readiness -H "Authorization: Bearer <ADMIN_TOKEN>"
```

7. Offer pack (Deriv presentation payload):
```bash
curl https://<render-backend>/api/admin/trading/offer-pack -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## 5) Emergency ops
- Trigger hard stop:
```bash
curl -X POST https://<render-backend>/api/admin/trading/emergency-stop \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_risk_override"}'
```

- Resume:
```bash
curl -X POST https://<render-backend>/api/admin/trading/resume -H "Authorization: Bearer <ADMIN_TOKEN>"
```

## 6) Minimum evidence window before presenting to Deriv
- 7 days continuous uptime.
- No unresolved critical alerts.
- Non-empty settled trade count and consistent realized PnL from ledger.
- Readiness endpoint stable with no emergency-stop state.
