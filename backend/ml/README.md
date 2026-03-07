ML service (FastAPI) scaffold

Quick start (Windows PowerShell):

1. Create & activate virtualenv

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies

```powershell
pip install -r requirements.txt
```

3. Run the service

```powershell
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Default behavior:
- The service expects historical signals at `../data/signals.json` (relative to `backend/ml`).
- To train, POST to `/train` (it will search for labeled records). If no labeled records are found, the endpoint will return an explanatory error.
- To predict, POST JSON to `/predict` with either `prediction`, `quote`, or `features`.

Notes:
- This is a scaffold to get started. Real-world performance requires labeled outcome data and careful feature engineering.
- The service persists the trained model to `model.joblib` in this folder.
