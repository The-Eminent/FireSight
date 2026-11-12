import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
import joblib

# Load processed data
X_train = np.load("processed_X_train.npy")
y_train = np.load("processed_y_train.npy")
X_test = np.load("processed_X_test.npy")
y_test = np.load("processed_y_test.npy")

print(f"Training samples: {X_train.shape}, Test samples: {X_test.shape}")

# Train Random Forest
model = RandomForestClassifier(n_estimators=100, max_depth=10, n_jobs=-1, random_state=42)
print("Training Random Forest...")
model.fit(X_train, y_train)

# Evaluate
y_pred = model.predict(X_test)
acc = accuracy_score(y_test, y_pred)
print(f"Test Accuracy: {acc:.4f}")
print("Classification Report:")
print(classification_report(y_test, y_pred))
print("Confusion Matrix:")
print(confusion_matrix(y_test, y_pred))

# Save model
joblib.dump(model, "wildfire_spread_model.joblib")
print("Model saved as wildfire_spread_model.joblib")
