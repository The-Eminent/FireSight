import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, roc_auc_score
import joblib
import time

print("Loading data...")
X_train = np.load("processed_X_train.npy")
y_train = np.load("processed_y_train_class.npy")
X_test = np.load("processed_X_test.npy")
y_test = np.load("processed_y_test_class.npy")

print(f"Training samples: {X_train.shape[0]}, Test samples: {X_test.shape[0]}")
print(f"Features: {X_train.shape[1]}")
print(f"Positive examples in training: {sum(y_train)} ({sum(y_train)/len(y_train)*100:.2f}%)")

# Train Gradient Boosting Classifier (better than Random Forest for this task)
print("Training Gradient Boosting Classifier...")
start_time = time.time()
model = GradientBoostingClassifier(
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
y_prob = model.predict_proba(X_test)[:, 1]  # Probability of class 1
acc = accuracy_score(y_test, y_pred)
auc = roc_auc_score(y_test, y_prob)
print(f"Test Accuracy: {acc:.4f}")
print(f"ROC AUC Score: {auc:.4f}")
print("\nClassification Report:")
print(classification_report(y_test, y_pred))
print("\nConfusion Matrix:")
print(confusion_matrix(y_test, y_pred))

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
joblib.dump(model, "wildfire_spread_classifier_advanced.joblib")
print("Model saved as wildfire_spread_classifier_advanced.joblib")
