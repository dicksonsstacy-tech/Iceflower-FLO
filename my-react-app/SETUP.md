Tailwind + Dev server setup

1. cd my-react-app
2. npm install
3. Install Tailwind (if not installed automatically):
   npm install -D tailwindcss postcss autoprefixer
4. Initialize Tailwind config (if needed):
   npx tailwindcss init -p
5. Start dev server:
   npm run dev

Notes:
- The frontend calls GET /api/predict for fallback predictions; run the backend in `backend/` to provide real or mock predictions.
- The backend also exposes GET /api/config -> { appId } so the frontend can learn the configured Deriv app id, and `GET /api/validate-token` to validate the token via a test authorize.
- The app can also receive live predictions via socket.io. Frontend connects to the backend socket at `VITE_BACKEND_URL` (set in `my-react-app/.env`) and listens for `prediction` events.
- You can set the frontend app id directly using `my-react-app/.env` with `VITE_DERIV_APP_ID=121210` (Vite only exposes env variables that start with `VITE_`).
- Components located in `src/components/*`, page entry `src/pages/Dashboard.jsx`.
- Replace the mock predictor with your model or extend the Deriv streaming logic for production-grade signals.
