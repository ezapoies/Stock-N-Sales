import pandas as pd


# Papua New Guinea salaries are commonly paid on a fortnightly cycle, so
# retail demand typically lifts around the middle and the end of each month.
PNG_PAYDAY_DAYS = frozenset({1, 2, 13, 14, 15, 16, 17, 27, 28, 29, 30, 31})

FEATURE_COLUMNS = [
    "product",
    "price",
    "dayOfWeek",
    "month",
    "dayOfMonth",
    "payday",
    "lag1",
    "lag7",
    "mean7",
    "mean28",
    "trend7",
    "trendSlope"
]


def is_png_payday(value):
    return pd.Timestamp(value).day in PNG_PAYDAY_DAYS


def linear_trend(values):
    """Least-squares slope (units per day) across the supplied daily values."""
    count = len(values)
    if count < 2:
        return 0.0

    mean_x = (count - 1) / 2
    mean_y = sum(values) / count
    denominator = sum((index - mean_x) ** 2 for index in range(count))
    if denominator == 0:
        return 0.0

    numerator = sum(
        (index - mean_x) * (value - mean_y)
        for index, value in enumerate(values)
    )
    return numerator / denominator


def make_feature_row(product, price, forecast_date, history):
    forecast_date = pd.Timestamp(forecast_date)
    recent_history = history[-28:]
    last_week = history[-7:]

    mean7 = sum(last_week) / len(last_week) if last_week else 0.0
    mean28 = sum(recent_history) / len(recent_history) if recent_history else 0.0
    trend_slope = linear_trend(recent_history) if len(recent_history) >= 2 else 0.0

    return {
        "product": str(product),
        "price": float(price),
        "dayOfWeek": forecast_date.dayofweek,
        "month": forecast_date.month,
        "dayOfMonth": forecast_date.day,
        "payday": 1 if is_png_payday(forecast_date) else 0,
        "lag1": float(history[-1]) if history else 0.0,
        "lag7": float(history[-7]) if len(history) >= 7 else 0.0,
        "mean7": mean7,
        "mean28": mean28,
        "trend7": mean7 - mean28,
        "trendSlope": trend_slope
    }


def make_daily_series(sales_rows, start_date=None, end_date=None):
    parsed_rows = []

    for row in sales_rows:
        try:
            sale_date = pd.Timestamp(row["date"]).normalize()
            quantity = float(row["quantity"])
            if pd.isna(sale_date) or quantity < 0:
                continue
        except (KeyError, TypeError, ValueError):
            continue

        parsed_rows.append((sale_date, quantity))

    if not parsed_rows:
        return pd.Series(dtype=float)

    daily_sales = {}
    for sale_date, quantity in parsed_rows:
        daily_sales[sale_date] = daily_sales.get(sale_date, 0.0) + quantity

    first_date = pd.Timestamp(start_date).normalize() if start_date else min(daily_sales)
    last_date = pd.Timestamp(end_date).normalize() if end_date else max(daily_sales)
    if last_date < first_date:
        return pd.Series(dtype=float)

    calendar = pd.date_range(first_date, last_date, freq="D")
    return pd.Series(
        [daily_sales.get(day, 0.0) for day in calendar],
        index=calendar,
        dtype=float
    )


def build_training_rows(product, price, series):
    rows = []
    quantities = series.tolist()
    dates = series.index

    for index in range(28, len(series)):
        rows.append(
            make_feature_row(
                product,
                price,
                dates[index],
                quantities[:index]
            )
            | {"quantity": quantities[index], "date": dates[index]}
        )

    return rows


def png_payday_lift(history):
    """Data-driven payday uplift (1.0 when history cannot support an estimate)."""
    if len(history) < 14:
        return 1.0

    payday_values = [
        float(value)
        for date, value in zip(history.index, history.tolist())
        if date.day in PNG_PAYDAY_DAYS
    ]
    regular_values = [
        float(value)
        for date, value in zip(history.index, history.tolist())
        if date.day not in PNG_PAYDAY_DAYS
    ]
    if not payday_values or not regular_values:
        return 1.0

    regular_mean = sum(regular_values) / len(regular_values)
    if regular_mean <= 0:
        return 1.0

    payday_mean = sum(payday_values) / len(payday_values)
    return max(0.75, min(1.5, payday_mean / regular_mean))


def summarize_trend(series):
    recent = series.tail(28)
    slope = linear_trend(recent.tolist()) if len(recent) >= 2 else 0.0
    average = float(recent.mean()) if not recent.empty else 0.0
    weekly_change = (slope * 7 / average * 100) if average > 0 else 0.0

    if slope > 0.05 and weekly_change >= 3:
        direction = "rising"
    elif slope < -0.05 and weekly_change <= -3:
        direction = "falling"
    else:
        direction = "stable"

    labels = {
        "rising": "Demand is trending up",
        "falling": "Demand is trending down",
        "stable": "Demand is broadly steady"
    }
    return {
        "direction": direction,
        "slopePerDay": round(slope, 3),
        "weeklyChangePercent": round(weekly_change, 1),
        "label": labels[direction]
    }


TREND_DAMPING = 0.5
MAX_TREND_STEPS = 28


def baseline_prediction(forecast_date, series):
    if series.empty:
        return 0.0

    forecast_date = pd.Timestamp(forecast_date).normalize()
    history = series[series.index < forecast_date]
    if history.empty:
        history = series

    recent = history.tail(28)
    recent_average = float(recent.mean()) if not recent.empty else 0.0
    same_weekday = history[history.index.dayofweek == forecast_date.dayofweek].tail(8)

    if len(same_weekday) >= 4:
        weekday_average = float(same_weekday.mean())
        prediction = (0.7 * weekday_average) + (0.3 * recent_average)
    else:
        prediction = recent_average

    # Project the recent linear trend forward, damped so long horizons do not drift.
    slope = linear_trend(recent.tolist()) if len(recent) >= 2 else 0.0
    steps = (forecast_date - recent.index[-1]).days if not recent.empty else 0
    prediction += TREND_DAMPING * slope * max(0, min(steps, MAX_TREND_STEPS))

    if is_png_payday(forecast_date):
        prediction *= png_payday_lift(history)

    return max(0.0, prediction)


def get_history_metadata(series, daily_sales_records):
    if series.empty:
        return {
            "historyDays": 0,
            "dailySalesRecords": daily_sales_records,
            "modelStatus": "insufficient_history",
            "warning": "No sales history is available for this product; the forecast is zero until sales are recorded."
        }

    history_days = len(series)
    if history_days < 28:
        warning = (
            f"Only {history_days} calendar days of sales history are available. "
            "This is a rough average, not a reliable trend forecast. "
            "Stock availability is not tracked historically, so zero-sales days may include stockouts."
        )
        model_status = "limited_history"
    else:
        warning = (
            "No historical stock-availability records are available, so zero-sales days may include stockouts."
        )
        model_status = "historical_baseline"

    return {
        "historyDays": history_days,
        "dailySalesRecords": daily_sales_records,
        "modelStatus": model_status,
        "warning": warning
    }


def build_forecast_features(product, price, forecast_date, series):
    forecast_date = pd.Timestamp(forecast_date).normalize()
    history = series[series.index < forecast_date]
    return make_feature_row(product, price, forecast_date, history.tolist())
