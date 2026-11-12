import tensorflow as tf
import numpy as np
import os
from tqdm import tqdm

DATA_DIR = "data"
TRAIN_FILES = [
    os.path.join(DATA_DIR, f"next_day_wildfire_spread_train_{i:02d}.tfrecord")
    for i in range(10)
]
TEST_FILES = [
    os.path.join(DATA_DIR, f"next_day_wildfire_spread_test_{i:02d}.tfrecord")
    for i in range(2)
]

FEATURES = [
    'elevation', 'th', 'vs', 'tmmn', 'tmmx', 'sph', 'pdsi', 'NDVI',
    'PrevFireMask', 'FireMask'
]

def get_feature_array(example, key, default_len=4096):
    feature = example.features.feature.get(key)
    if feature is None or not feature.float_list.value:
        return np.zeros(default_len, dtype=np.float32)
    arr = np.array(feature.float_list.value, dtype=np.float32)
    if arr.size < default_len:
        arr = np.pad(arr, (0, default_len - arr.size), 'constant')
    return arr

def extract_features(file_paths, max_samples=20000):
    print(f"Processing {len(file_paths)} files...")

    X_data = []
    y_class = []
    y_regress = []
    count = 0
    skipped = 0

    raw_dataset = tf.data.TFRecordDataset(file_paths)

    for raw_record in tqdm(raw_dataset, desc="Processing records"):
        if count >= max_samples:
            break

        try:
            example = tf.train.Example()
            example.ParseFromString(raw_record.numpy())
            elevation = get_feature_array(example, 'elevation')
            wind_dir = get_feature_array(example, 'th')
            wind_speed = get_feature_array(example, 'vs')
            temp_min = get_feature_array(example, 'tmmn')
            temp_max = get_feature_array(example, 'tmmx')
            humidity = get_feature_array(example, 'sph')
            drought = get_feature_array(example, 'pdsi')
            vegetation = get_feature_array(example, 'NDVI')
            prev_fire = get_feature_array(example, 'PrevFireMask')
            fire_mask = get_feature_array(example, 'FireMask')

            # Calculate fire areas
            current_area = np.sum(prev_fire)
            future_area = np.sum(fire_mask)
            
            # Skip records with no fire or very small fires
            if current_area < 10.0:
                skipped += 1
                continue
                
            # Calculate spread ratio
            spread_ratio = future_area / current_area
            
            # Skip unreasonable spread ratios
            if spread_ratio > 10.0 or spread_ratio < 0.1:
                skipped += 1
                continue
                
            spread_label = 1 if spread_ratio > 1.2 else 0

            # --- Feature Engineering ---
            features = []
            # 1. Environmental stats
            for arr in [elevation, wind_dir, wind_speed, temp_min, temp_max, humidity, drought, vegetation]:
                features.extend([np.mean(arr), np.max(arr)])

            # 2. Fire mask stats
            features.extend([np.sum(prev_fire), np.mean(prev_fire)])

            # 3. Wind vector components (mean)
            wind_dir_mean = np.mean(wind_dir)
            wind_speed_mean = np.mean(wind_speed)
            wind_east = wind_speed_mean * np.cos(np.radians(wind_dir_mean))  # E/W
            wind_north = wind_speed_mean * np.sin(np.radians(wind_dir_mean)) # N/S
            features.append(wind_east)
            features.append(wind_north)

            # 4. Wind-elevation and drought-vegetation interaction
            features.append(np.mean(elevation) * wind_speed_mean)
            features.append(np.mean(drought) * np.mean(vegetation))

            # 5. Fire shape ratio (width/height)
            try:
                fire_mask_2d = prev_fire.reshape(64, 64)
                if np.sum(fire_mask_2d) > 0:
                    y_indices, x_indices = np.where(fire_mask_2d > 0)
                    fire_width = np.max(x_indices) - np.min(x_indices)
                    fire_height = np.max(y_indices) - np.min(y_indices)
                    shape_ratio = fire_width / (fire_height + 1e-6)
                else:
                    shape_ratio = 1.0
            except Exception:
                shape_ratio = 1.0
            features.append(shape_ratio)
            # --- End Feature Engineering ---

            X_data.append(features)
            y_class.append(spread_label)
            y_regress.append(spread_ratio)
            count += 1

        except Exception as e:
            print(f"Error processing record: {e}")
            continue

    print(f"Skipped {skipped} records with no fire or unreasonable spread ratios")
    return np.array(X_data), np.array(y_class), np.array(y_regress)

if __name__ == "__main__":
    print("Extracting features from training data...")
    X_train, y_train_class, y_train_regress = extract_features(TRAIN_FILES, max_samples=20000)

    print("Extracting features from test data...")
    X_test, y_test_class, y_test_regress = extract_features(TEST_FILES, max_samples=2000)

    print("Saving processed data...")
    np.save("processed_X_train.npy", X_train)
    np.save("processed_y_train_class.npy", y_train_class)
    np.save("processed_y_train_regress.npy", y_train_regress)
    np.save("processed_X_test.npy", X_test)
    np.save("processed_y_test_class.npy", y_test_class)
    np.save("processed_y_test_regress.npy", y_test_regress)

    print(f"Processed and saved {len(X_train)} training samples and {len(X_test)} test samples")
    print(f"Training data shape: {X_train.shape}")
    print(f"Test data shape: {X_test.shape}")
    print(f"Positive examples in training: {sum(y_train_class)} ({sum(y_train_class)/len(y_train_class)*100:.2f}%)")
    print(f"Positive examples in test: {sum(y_test_class)} ({sum(y_test_class)/len(y_test_class)*100:.2f}%)")
    print(f"Spread ratio stats (train): min={np.min(y_train_regress):.2f}, max={np.max(y_train_regress):.2f}, mean={np.mean(y_train_regress):.2f}")
    print(f"Spread ratio stats (test): min={np.min(y_test_regress):.2f}, max={np.max(y_test_regress):.2f}, mean={np.mean(y_test_regress):.2f}")
