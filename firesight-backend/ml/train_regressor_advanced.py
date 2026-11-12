import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_squared_error, r2_score, mean_absolute_error
import joblib
import time

print("Loading data...")
X_train = np.load("processed_X_train.npy")
y_train = np.load("processed_y_train_regress.npy")
X_test = np.load("processed_X_test.npy")
y_test = np.load("processed_y_test_regress.npy")

print(f"Training samples: {X_train.shape[0]}, Test samples: {X_test.shape[0]}")
print(f"Features: {X_train.shape[1]}")
print(f"Spread ratio stats (train): min={np.min(y_train):.2f}, max={np.max(y_train):.2f}, mean={np.mean(y_train):.2f}")

# Train Gradient Boosting Regressor (better than Random Forest for this task)
print("Training Gradient Boosting Regressor...")
start_time = time.time()
model = GradientBoostingRegressor(
    n_estimators=200,
    max_depth=5,
    learning_rate=0.1,
    min_samples_split=5,
    min_samples_leaf=2,
    random_state=42
)
model.fit(X_train, y_train)
training_time = time.time() - start_time
print(f"Training completed in {training_time:.2f} seconds")

# Evaluate
print("Evaluating model...")
y_pred = model.predict(X_test)
mse = mean_squared_error(y_test, y_pred)
rmse = np.sqrt(mse)
mae = mean_absolute_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)
print(f"Test MSE: {mse:.4f}")
print(f"Test RMSE: {rmse:.4f}")
print(f"Test MAE: {mae:.4f}")
print(f"Test R² Score: {r2:.4f}")

# Feature importance
feature_names = [
    "elevation_mean", "elevation_max", 
    "wind_dir_mean", "wind_dir_max",
    "wind_speed_mean", "wind_speed_max",
    "temp_min_mean", "temp_min_max",
    "temp_max_mean", "temp_max_max",
    "humidity_mean", "humidity_max",
    "drought_mean", "drought_max",
    "vegetation_mean", "vegetation_max",
    "fire_sum", "fire_mean",
    "wind_east", "wind_north",
    "wind_elevation", "drought_vegetation",
    "fire_shape_ratio"
]

print("\nFeature Importance:")
importances = model.feature_importances_
indices = np.argsort(importances)[::-1]
for i in range(len(feature_names)):
    print(f"{i+1}. {feature_names[indices[i]]}: {importances[indices[i]]:.4f}")

# Save model
joblib.dump(model, "wildfire_spread_regressor_advanced.joblib")
print("Model saved as wildfire_spread_regressor_advanced.joblib")
