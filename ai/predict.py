import os

import joblib
import pandas as pd

from ai.forecasting import (
    FEATURE_COLUMNS,
    baseline_prediction,
    build_forecast_features,
    get_history_metadata,
    is_png_payday,
    make_daily_series,
    summarize_trend
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Canonical model trained by ai/train_model.py. LEGACY_MODEL_PATH keeps the
# older file around as a read-only fallback so devices that synced before the
# trend-aware retrain still get a forecast instead of a 500.
MODEL_PATH = os.path.join(
    BASE_DIR,
    "ai",
    "models",
    "sales_forecast_v2.pkl"
)
LEGACY_MODEL_PATH = os.path.join(
    BASE_DIR,
    "ai",
    "models",
    "sales_prediction_model.pkl"
)
# Bundles stamped with one of these versions are accepted; v2 files carry the
# model under "model" with a metadata dict, while legacy v1 files are a bare
# sklearn pipeline with only the original four numeric features.
SUPPORTED_FEATURE_VERSIONS = (2, 3)

_model_bundle = None
_model_mtime = None


def _normalise_bundle(bundle):
    """Return {model, feature_version, numeric_columns} or None if unusable."""
    if isinstance(bundle, dict) and bundle.get("model") is not None:
        metadata = bundle.get("metadata", {}) or {}
        try:
            feature_version = int(metadata.get("featureVersion", 0))
        except (TypeError, ValueError):
            return None
        if (
            metadata.get("source") == "local_sqlite_sales"
            and feature_version in SUPPORTED_FEATURE_VERSIONS
        ):
            return {
                "model": bundle["model"],
                "feature_version": feature_version,
                "numeric_columns": None,  # full FEATURE_COLUMNS
            }
        return None

    # Legacy file: a bare sklearn pipeline trained on the original four
    # numeric features (price, dayOfWeek, dayOfMonth, month).
    if hasattr(bundle, "predict"):
        return {
            "model": bundle,
            "feature_version": 1,
            "numeric_columns": ["price", "dayOfWeek", "dayOfMonth", "month"],
        }
    return None


def _load_bundle_from(path):
    try:
        bundle = joblib.load(path)
    except Exception as error:
        print(f"Forecast model at {path} could not be loaded: {error}")
        return None
    normalised = _normalise_bundle(bundle)
    if normalised is None:
        print(f"Forecast model at {path} has an unsupported format.")
    return normalised


def _load_trained_model():
    global _model_bundle, _model_mtime

    candidates = [MODEL_PATH, LEGACY_MODEL_PATH]
    existing = [path for path in candidates if os.path.exists(path)]
    if not existing:
        _model_bundle = None
        _model_mtime = None
        return None

    newest_mtime = max(os.path.getmtime(path) for path in existing)
    if _model_mtime == newest_mtime:
        return _model_bundle

    for path in sorted(existing, key=os.path.getmtime, reverse=True):
        normalised = _load_bundle_from(path)
        if normalised is not None:
            _model_bundle = normalised
            _model_mtime = newest_mtime
            return _model_bundle

    _model_bundle = None
    _model_mtime = newest_mtime
    return None


def predict_demand(product, price, forecast_date, sales_history=None):
    forecast_date = pd.Timestamp(forecast_date).normalize()
    price = float(price)
    sales_history = sales_history or []

    past_sales = []
    for sale in sales_history:
        try:
            if pd.Timestamp(sale["date"]).normalize() < forecast_date:
                past_sales.append(sale)
        except (KeyError, TypeError, ValueError):
            continue

    observed_series = make_daily_series(past_sales)
    series = make_daily_series(
        past_sales,
        end_date=forecast_date - pd.Timedelta(days=1)
    )
    metadata = get_history_metadata(observed_series, len(past_sales))
    metadata["trend"] = summarize_trend(observed_series)

    if series.empty:
        prediction = 0.0
    else:
        bundle = _load_trained_model()
        if bundle and len(series) >= 28:
            try:
                features = _build_feature_frame(
                    bundle,
                    build_forecast_features(
                        product,
                        price,
                        forecast_date,
                        series
                    )
                )
                prediction = float(bundle["model"].predict(features)[0])
                prediction = max(0.0, prediction)
            except Exception as error:
                print(f"Trained-model forecast failed, using baseline: {error}")
                bundle = None
                prediction = baseline_prediction(forecast_date, observed_series)

            if bundle is not None:
                metadata["modelStatus"] = "trained_model"
                metadata["warning"] = (
                    "Forecast uses your sales history. Stockouts are not tracked historically, "
                    "so zero-sales days may understate demand."
                )
        else:
            prediction = baseline_prediction(forecast_date, observed_series)

    return {
        "predictedDemand": round(prediction, 2),
        **metadata
    }


def _build_feature_frame(bundle, feature_row):
    """Project a full feature row onto what the loaded model expects."""
    numeric_columns = bundle.get("numeric_columns")
    if numeric_columns:
        # Legacy pipeline: its ColumnTransformer still one-hot encodes the
        # product column, so it must be present alongside the numeric columns.
        frame = pd.DataFrame([{
            "product": feature_row["product"],
            **{column: feature_row[column] for column in numeric_columns},
        }])
        try:
            preprocessor = bundle["model"].named_steps.get("preprocessor")
            expected = (
                list(preprocessor.feature_names_in_)
                if preprocessor is not None
                and hasattr(preprocessor, "feature_names_in_")
                else ["product", *numeric_columns]
            )
            return frame.reindex(columns=expected)
        except Exception:
            return frame
    return pd.DataFrame([feature_row], columns=FEATURE_COLUMNS)


def _predict_with_model(bundle, product, price, target_date, series):
    features = _build_feature_frame(
        bundle,
        build_forecast_features(product, price, target_date, series)
    )
    prediction = float(bundle["model"].predict(features)[0])
    return max(0.0, prediction)


def predict_demand_range(product, price, start_date, days, sales_history=None):
    """Forecast every day in a flexible period, feeding predictions back as history."""
    start_date = pd.Timestamp(start_date).normalize()
    price = float(price)
    sales_history = sales_history or []

    try:
        horizon_days = int(days)
    except (TypeError, ValueError):
        horizon_days = 1
    horizon_days = max(1, min(horizon_days, 180))

    past_sales = []
    for sale in sales_history:
        try:
            if pd.Timestamp(sale["date"]).normalize() < start_date:
                past_sales.append(sale)
        except (KeyError, TypeError, ValueError):
            continue

    observed_series = make_daily_series(past_sales)
    metadata = get_history_metadata(observed_series, len(past_sales))
    trend = summarize_trend(observed_series)

    working = make_daily_series(
        past_sales,
        end_date=start_date - pd.Timedelta(days=1)
    )

    bundle = _load_trained_model()

    daily = []
    total = 0.0
    use_model = bool(bundle) and len(working) >= 28
    for offset in range(horizon_days):
        target_date = start_date + pd.Timedelta(days=offset)
        value = 0.0
        if not working.empty:
            if use_model:
                try:
                    value = _predict_with_model(bundle, product, price, target_date, working)
                except Exception as error:
                    print(f"Trained-model forecast failed, using baseline: {error}")
                    use_model = False
                    value = baseline_prediction(target_date, working)
            else:
                value = baseline_prediction(target_date, working)

        value = max(0.0, float(value))
        total += value
        daily.append({
            "date": target_date.date().isoformat(),
            "dayOfWeek": target_date.dayofweek,
            "predictedDemand": round(value, 2),
            "payday": bool(is_png_payday(target_date))
        })
        working.loc[target_date] = value

    if use_model:
        metadata["modelStatus"] = "trained_model"
        metadata["warning"] = (
            "Forecast uses your sales history. Stockouts are not tracked historically, "
            "so zero-sales days may understate demand."
        )

    return {
        "startDate": start_date.date().isoformat(),
        "endDate": (
            start_date + pd.Timedelta(days=horizon_days - 1)
        ).date().isoformat(),
        "horizonDays": horizon_days,
        "totalDemand": round(total, 2),
        "averageDailyDemand": round(total / horizon_days, 2),
        "daily": daily,
        "trend": trend,
        **metadata
    }


if __name__ == "__main__":
    tomorrow = pd.Timestamp.now().normalize() + pd.Timedelta(days=1)
    result = predict_demand(
        product="Coca-Cola",
        price=5.00,
        forecast_date=tomorrow,
        sales_history=[]
    )
    print(
        f"Predicted demand: {result['predictedDemand']} units "
        f"({result['modelStatus']})"
    )
