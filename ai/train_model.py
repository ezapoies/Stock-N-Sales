import os
import sys

import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "backend"))
sys.path.insert(0, PROJECT_ROOT)

from database import get_db_connection
from ai.forecasting import FEATURE_COLUMNS, build_training_rows, make_daily_series

MODEL_PATH = os.path.join(
    PROJECT_ROOT,
    "ai",
    "models",
    "sales_forecast_v2.pkl"
)
MINIMUM_HISTORY_DAYS = 60
MINIMUM_TRAIN_ROWS = 60


def load_real_sales():
    connection = get_db_connection()
    try:
        return connection.execute("""
            SELECT
                productName AS product,
                date,
                quantity,
                price
            FROM sales
            ORDER BY date ASC
        """).fetchall()
    finally:
        connection.close()


def train_model():
    records = [dict(row) for row in load_real_sales()]
    if not records:
        raise RuntimeError(
            "There are no recorded sales yet. Add real sales before training."
        )

    sales = pd.DataFrame(records)
    sales["date"] = pd.to_datetime(
        sales["date"],
        format="ISO8601",
        errors="coerce"
    )
    sales["quantity"] = pd.to_numeric(sales["quantity"], errors="coerce")
    sales["price"] = pd.to_numeric(sales["price"], errors="coerce")
    sales = sales.dropna(subset=["product", "date", "quantity", "price"])
    if sales.empty:
        raise RuntimeError("No valid sales records are available for training.")

    all_dates = pd.DatetimeIndex(sales["date"].dt.normalize().unique()).sort_values()
    if len(all_dates) < MINIMUM_HISTORY_DAYS:
        raise RuntimeError(
            f"Only {len(all_dates)} calendar days contain sales. "
            f"At least {MINIMUM_HISTORY_DAYS} days are required before training."
        )

    training_rows = []
    for product, product_sales in sales.groupby("product"):
        product_sales = product_sales.sort_values("date")
        daily_prices = product_sales.groupby(
            product_sales["date"].dt.normalize()
        )["price"].mean()
        price = float(product_sales["price"].median())
        series = make_daily_series(
            product_sales[["date", "quantity"]].to_dict("records")
        )
        if len(series) < MINIMUM_HISTORY_DAYS:
            continue

        rows = build_training_rows(product, price, series)
        for row in rows:
            row["price"] = float(
                daily_prices.loc[row["date"]]
                if row["date"] in daily_prices.index
                else price
            )
        training_rows.extend(rows)

    if len(training_rows) < MINIMUM_TRAIN_ROWS:
        raise RuntimeError(
            f"Only {len(training_rows)} supervised training rows could be built. "
            "Record more real daily sales before training."
        )

    dataset = pd.DataFrame(training_rows).sort_values("date").reset_index(drop=True)
    dates = pd.DatetimeIndex(dataset["date"].unique()).sort_values()
    split_index = max(1, int(len(dates) * 0.8))
    if split_index >= len(dates):
        raise RuntimeError("Not enough dates remain for a chronological test period.")

    split_date = dates[split_index]
    train_rows = dataset[dataset["date"] < split_date]
    test_rows = dataset[dataset["date"] >= split_date]
    if len(train_rows) < MINIMUM_TRAIN_ROWS or test_rows.empty:
        raise RuntimeError(
            "Not enough sales history on both sides of the chronological test split."
        )

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "product",
                OneHotEncoder(handle_unknown="ignore"),
                ["product"]
            ),
            (
                "numeric",
                "passthrough",
                [column for column in FEATURE_COLUMNS if column != "product"]
            )
        ]
    )
    model = Pipeline(steps=[
        ("preprocessor", preprocessor),
        (
            "model",
            RandomForestRegressor(
                n_estimators=250,
                min_samples_leaf=2,
                random_state=42,
                n_jobs=-1
            )
        )
    ])

    model.fit(train_rows[FEATURE_COLUMNS], train_rows["quantity"])
    model_predictions = model.predict(test_rows[FEATURE_COLUMNS]).clip(min=0)
    baseline_predictions = test_rows["mean7"].to_numpy().clip(min=0)
    model_mae = mean_absolute_error(test_rows["quantity"], model_predictions)
    baseline_mae = mean_absolute_error(test_rows["quantity"], baseline_predictions)

    print(f"Chronological holdout starts: {split_date.date()}")
    print(f"Training rows: {len(train_rows)}; holdout rows: {len(test_rows)}")
    print(f"Model MAE: {model_mae:.2f} units/day")
    print(f"Recent-average baseline MAE: {baseline_mae:.2f} units/day")

    if model_mae > baseline_mae:
        raise RuntimeError(
            "The model did not beat the recent-average baseline. "
            "No model was saved; collect more representative sales history and try again."
        )

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump({
        "model": model,
        "metadata": {
            "source": "local_sqlite_sales",
            "featureVersion": 3,
            "trainedThrough": str(dataset["date"].max().date()),
            "historyDays": len(all_dates),
            "validationMae": float(model_mae),
            "baselineMae": float(baseline_mae)
        }
    }, MODEL_PATH)
    print(f"Validated real-sales model saved to: {MODEL_PATH}")


if __name__ == "__main__":
    train_model()
