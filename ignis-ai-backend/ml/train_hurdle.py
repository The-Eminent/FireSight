"""Train and evaluate the physics-informed XGBoost hurdle model."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
import xgboost
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    mean_absolute_error,
    mean_squared_error,
    precision_recall_fscore_support,
    roc_auc_score,
)
from xgboost import XGBClassifier, XGBRegressor


FEATURE_SET_VERSION = "boundary_physics_v2"
RAW_COLUMNS = (
    "elevation", "th", "vs", "tmmn", "tmmx", "sph", "pr", "pdsi",
    "NDVI", "population", "erc", "physics_ros_m_min",
    "physics_heading_deg", "physics_baseline_distance_m",
    "wind_alignment_cosine", "neighboring_fire_pixels",
    "slope_wind_interaction", "spreads", "residual_distance_m",
)
FEATURE_COLUMNS = (
    "elevation", "vs", "wind_from_sin", "wind_from_cos", "tmmn", "tmmx",
    "sph", "pr", "pdsi", "NDVI", "population", "erc",
    "physics_ros_m_min", "physics_heading_sin", "physics_heading_cos",
    "physics_baseline_distance_m", "wind_alignment_cosine",
    "neighboring_fire_pixels", "slope_wind_interaction",
)
CLASSIFIER_PARAMS = {
    "n_estimators": 500, "max_depth": 6, "learning_rate": 0.05,
    "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5,
    "reg_lambda": 1.0, "objective": "binary:logistic", "eval_metric": "aucpr",
    "tree_method": "hist", "random_state": 42, "n_jobs": -1,
}
REGRESSOR_PARAMS = {
    "n_estimators": 500, "max_depth": 6, "learning_rate": 0.05,
    "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5,
    "reg_lambda": 1.0, "objective": "reg:squarederror", "eval_metric": "rmse",
    "tree_method": "hist", "random_state": 42, "n_jobs": -1,
}


def load_split(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path, usecols=RAW_COLUMNS)
    if not np.isfinite(frame.to_numpy(dtype=np.float64)).all():
        raise ValueError(f"{path} contains non-finite training values")
    return frame


def build_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Return the ordered, inference-available feature contract."""
    wind_radians = np.deg2rad(frame["th"])
    heading_radians = np.deg2rad(frame["physics_heading_deg"])
    values = {
        "elevation": frame["elevation"], "vs": frame["vs"],
        "wind_from_sin": np.sin(wind_radians),
        "wind_from_cos": np.cos(wind_radians),
        "tmmn": frame["tmmn"], "tmmx": frame["tmmx"],
        "sph": frame["sph"], "pr": frame["pr"], "pdsi": frame["pdsi"],
        "NDVI": frame["NDVI"], "population": frame["population"],
        "erc": frame["erc"], "physics_ros_m_min": frame["physics_ros_m_min"],
        "physics_heading_sin": np.sin(heading_radians),
        "physics_heading_cos": np.cos(heading_radians),
        "physics_baseline_distance_m": frame["physics_baseline_distance_m"],
        "wind_alignment_cosine": frame["wind_alignment_cosine"],
        "neighboring_fire_pixels": frame["neighboring_fire_pixels"],
        "slope_wind_interaction": frame["slope_wind_interaction"],
    }
    return pd.DataFrame(values, columns=FEATURE_COLUMNS, dtype=np.float32)


def classifier_metrics(y_true: pd.Series, probabilities: np.ndarray) -> dict[str, float]:
    predictions = (probabilities >= 0.5).astype(np.uint8)
    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, predictions, average="binary", zero_division=0,
    )
    return {
        "precision": float(precision), "recall": float(recall), "f1": float(f1),
        "accuracy": float(accuracy_score(y_true, predictions)),
        "pr_auc": float(average_precision_score(y_true, probabilities)),
        "roc_auc": float(roc_auc_score(y_true, probabilities)),
    }


def regressor_metrics(y_true: pd.Series, predictions: np.ndarray) -> dict[str, float]:
    return {
        "rmse_m": float(np.sqrt(mean_squared_error(y_true, predictions))),
        "mae_m": float(mean_absolute_error(y_true, predictions)),
    }


def append_runs(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0])
    write_header = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        if write_header:
            writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    backend = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=backend / "data" / "processed")
    parser.add_argument("--model-dir", type=Path, default=Path(__file__).parent / "models")
    parser.add_argument("--runs", type=Path, default=Path(__file__).parent / "experiments" / "runs.csv")
    args = parser.parse_args()

    frames = {
        split: load_split(args.data_dir / f"{split}_boundary_points.csv")
        for split in ("train", "eval", "test")
    }
    features = {split: build_features(frame) for split, frame in frames.items()}
    train_labels = frames["train"]["spreads"].astype(np.uint8)
    negatives, positives = np.bincount(train_labels, minlength=2)
    scale_pos_weight = float(negatives / positives)

    classifier = XGBClassifier(**CLASSIFIER_PARAMS, scale_pos_weight=scale_pos_weight)
    classifier.fit(features["train"], train_labels)
    classification = {
        split: classifier_metrics(
            frames[split]["spreads"].astype(np.uint8),
            classifier.predict_proba(features[split])[:, 1],
        )
        for split in ("eval", "test")
    }

    positive = {split: frames[split]["spreads"].eq(1) for split in frames}
    regressor = XGBRegressor(**REGRESSOR_PARAMS)
    regressor.fit(
        features["train"].loc[positive["train"]],
        frames["train"].loc[positive["train"], "residual_distance_m"],
    )
    regression = {
        split: regressor_metrics(
            frames[split].loc[positive[split], "residual_distance_m"],
            regressor.predict(features[split].loc[positive[split]]),
        )
        for split in ("eval", "test")
    }

    timestamp = datetime.now(timezone.utc)
    run_id = timestamp.strftime("%Y%m%dT%H%M%SZ") + "_hurdle_v2"
    args.model_dir.mkdir(parents=True, exist_ok=True)
    classifier_path = args.model_dir / f"{run_id}_classifier.json"
    regressor_path = args.model_dir / f"{run_id}_regressor.json"
    metadata_path = args.model_dir / f"{run_id}_metadata.json"
    classifier.save_model(classifier_path)
    regressor.save_model(regressor_path)
    metadata = {
        "run_id": run_id, "created_at": timestamp.isoformat(),
        "feature_set_version": FEATURE_SET_VERSION, "features": list(FEATURE_COLUMNS),
        "classifier_threshold": 0.5, "scale_pos_weight": scale_pos_weight,
        "runtime_defaults": {
            name: {"value": float(frames["train"][name].median()), "source": "train_median"}
            for name in ("pdsi", "NDVI", "population", "erc")
        },
        "classifier_params": CLASSIFIER_PARAMS, "regressor_params": REGRESSOR_PARAMS,
        "rows": {
            split: {"all": len(frames[split]), "positive": int(positive[split].sum())}
            for split in frames
        },
        "metrics": {"classifier": classification, "regressor": regression},
        "models": {"classifier": str(classifier_path), "regressor": str(regressor_path)},
        "versions": {"xgboost": xgboost.__version__, "scikit_learn": sklearn.__version__},
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    common = {
        "run_id": run_id, "timestamp": timestamp.isoformat(),
        "feature_set_version": FEATURE_SET_VERSION, "xgboost_version": xgboost.__version__,
        "scikit_learn_version": sklearn.__version__, "train_rows": len(frames["train"]),
        "eval_rows": len(frames["eval"]), "test_rows": len(frames["test"]),
    }
    append_runs(args.runs, [
        {**common, "task": "classifier", "algorithm": "XGBClassifier",
         "hyperparameters": json.dumps({**CLASSIFIER_PARAMS, "scale_pos_weight": scale_pos_weight}, sort_keys=True),
         "eval_metrics": json.dumps(classification["eval"], sort_keys=True),
         "test_metrics": json.dumps(classification["test"], sort_keys=True), "model_file": str(classifier_path)},
        {**common, "task": "regressor", "algorithm": "XGBRegressor",
         "train_rows": int(positive["train"].sum()),
         "eval_rows": int(positive["eval"].sum()),
         "test_rows": int(positive["test"].sum()),
         "hyperparameters": json.dumps(REGRESSOR_PARAMS, sort_keys=True),
         "eval_metrics": json.dumps(regression["eval"], sort_keys=True),
         "test_metrics": json.dumps(regression["test"], sort_keys=True), "model_file": str(regressor_path)},
    ])
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
