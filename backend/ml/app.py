from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
import os
import json
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.metrics import confusion_matrix, classification_report
import joblib
import numpy as np

app = FastAPI(title="Iceflower ML Service")

BASE_DIR = os.path.dirname(__file__)
DATA_FILE = os.path.normpath(os.path.join(BASE_DIR, '..', 'data', 'signals.json'))
MODEL_FILE = os.path.join(BASE_DIR, 'model.joblib')

class PredictRequest(BaseModel):
    # Accept either a numeric quote, an existing prediction, or precomputed features
    quote: float = None
    prediction: int = None
    strength: float = None
    features: dict = None


def load_signals():
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE, 'r', encoding='utf8') as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def extract_features(df):
    # Expect df to contain at least columns: prediction, strength, quote, ts
    X = pd.DataFrame()
    if 'prediction' in df:
        X['last_pred'] = df['prediction'].fillna(-1).astype(int)
    else:
        X['last_pred'] = -1

    if 'strength' in df:
        X['strength'] = df['strength'].fillna(df['strength'].mean())
    else:
        X['strength'] = 50

    if 'quote' in df:
        # fractional part of quote often carries variation
        X['quote_frac'] = df['quote'].apply(lambda q: float(q) - np.floor(float(q)) if pd.notnull(q) else 0.0)
    else:
        X['quote_frac'] = 0.0

    if 'ts' in df:
        # time-based features
        try:
            ts = pd.to_datetime(df['ts'], unit='ms')
            X['hour'] = ts.dt.hour
            X['minute'] = ts.dt.minute
        except Exception:
            X['hour'] = 0
            X['minute'] = 0
    else:
        X['hour'] = 0
        X['minute'] = 0

    return X


@app.get('/health')
def health():
    return {'ok': True}


@app.post('/train')
def train():
    records = load_signals()
    if not records:
        raise HTTPException(status_code=400, detail='No signal records found at data/signals.json')

    # Find labeled records containing an explicit 'outcome_digit' field (required)
    labeled = [r for r in records if r.get('outcome_digit') is not None]
    if len(labeled) < 10:
        raise HTTPException(status_code=400, detail=f'Not enough labeled records for training (found {len(labeled)}). Add outcome_digit to records and retry.')

    df = pd.DataFrame(labeled)
    y = df['outcome_digit'].astype(int)
    X = extract_features(df)

    # Simple RandomForest baseline
    clf = RandomForestClassifier(n_estimators=100, random_state=42)
    scores = cross_val_score(clf, X, y, cv=5, scoring='accuracy')
    clf.fit(X, y)

    joblib.dump({'clf': clf, 'meta': {'classes': clf.classes_.tolist()}}, MODEL_FILE)

    return {'ok': True, 'cv_accuracy_mean': float(scores.mean()), 'cv_accuracy_std': float(scores.std()), 'trained_on': len(df)}


@app.post('/predict')
def predict(req: PredictRequest):
    if not os.path.exists(MODEL_FILE):
        raise HTTPException(status_code=400, detail='Model not found. Train the model first via POST /train')

    model_bundle = joblib.load(MODEL_FILE)
    clf = model_bundle['clf']
    classes = list(model_bundle.get('meta', {}).get('classes', np.arange(10).tolist()))

    # Build a single-row dataframe for features
    if req.features:
        row = pd.DataFrame([req.features])
        # ensure expected columns
        for c in ['last_pred', 'strength', 'quote_frac', 'hour', 'minute']:
            if c not in row:
                row[c] = 0
        X = row[['last_pred','strength','quote_frac','hour','minute']]
    else:
        # make from quote/prediction/strength
        data = {'prediction': req.prediction if req.prediction is not None else -1,
                'strength': req.strength if req.strength is not None else 50,
                'quote': req.quote if req.quote is not None else None,
                'ts': None}
        df = pd.DataFrame([data])
        X = extract_features(df)

    probs = clf.predict_proba(X)[0]
    # Map probabilities to classes
    class_probs = {int(c): float(p) for c, p in zip(clf.classes_, probs)}
    best_idx = int(clf.predict(X)[0])
    confidence = float(class_probs.get(best_idx, 0.0))

    return {'ok': True, 'prediction': int(best_idx), 'confidence': confidence, 'probs': class_probs}


@app.get('/backtest')
def backtest():
    # Evaluate trained model on historical labeled set
    if not os.path.exists(MODEL_FILE):
        raise HTTPException(status_code=400, detail='Model not found. Train the model first via POST /train')
    records = load_signals()
    labeled = [r for r in records if r.get('outcome_digit') is not None]
    if len(labeled) < 2:
        raise HTTPException(status_code=400, detail='Not enough labeled records for backtest')

    df = pd.DataFrame(labeled)
    y = df['outcome_digit'].astype(int)
    X = extract_features(df)

    model_bundle = joblib.load(MODEL_FILE)
    clf = model_bundle['clf']

    preds = clf.predict(X)
    acc = float((preds == y).mean())

    return {'ok': True, 'accuracy': acc, 'tested_on': len(y)}


@app.get('/evaluate')
def evaluate():
    # Provide confusion matrix, per-class metrics, and a recommended confidence threshold
    if not os.path.exists(MODEL_FILE):
        raise HTTPException(status_code=400, detail='Model not found. Train the model first via POST /train')

    records = load_signals()
    labeled = [r for r in records if r.get('outcome_digit') is not None]
    if len(labeled) < 2:
        raise HTTPException(status_code=400, detail='Not enough labeled records for evaluation')

    df = pd.DataFrame(labeled)
    y = df['outcome_digit'].astype(int)
    X = extract_features(df)

    model_bundle = joblib.load(MODEL_FILE)
    clf = model_bundle['clf']

    probs = clf.predict_proba(X)
    preds = clf.predict(X)

    # confusion matrix
    cm = confusion_matrix(y, preds, labels=clf.classes_).tolist()
    report = classification_report(y, preds, labels=clf.classes_, output_dict=True)

    # Evaluate thresholds: pick threshold maximizing (accuracy * coverage)
    max_score = -1
    best = {'threshold': 0.0, 'accuracy': 0.0, 'coverage': 1.0}
    max_probs = probs.max(axis=1)
    for t in [i / 100.0 for i in range(10, 96, 5)]:
        mask = max_probs >= t
        if mask.sum() == 0:
            continue
        acc = float((preds[mask] == y[mask]).mean())
        coverage = float(mask.mean())
        score = acc * coverage
        if score > max_score:
            max_score = score
            best = {'threshold': float(t), 'accuracy': acc, 'coverage': coverage}

    return {'ok': True, 'confusion_matrix': cm, 'report': report, 'recommended': best}


@app.get('/health')
def health_check():
    return {'status': 'healthy', 'service': 'ml-service'}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
