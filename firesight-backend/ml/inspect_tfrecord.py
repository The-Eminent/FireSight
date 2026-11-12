import tensorflow as tf

def inspect_tfrecord(file_path):
    raw_dataset = tf.data.TFRecordDataset([file_path])
    for raw_record in raw_dataset.take(1):
        example = tf.train.Example()
        example.ParseFromString(raw_record.numpy())
        print("Keys in the example:")
        for key in example.features.feature.keys():
            print(f"- {key}")
        print("\nFeature types and lengths:")
        for key, feature in example.features.feature.items():
            kind = feature.WhichOneof('kind')
            if kind == 'float_list':
                print(f"{key}: float_list with length {len(feature.float_list.value)}")
            elif kind == 'int64_list':
                print(f"{key}: int64_list with length {len(feature.int64_list.value)}")
            elif kind == 'bytes_list':
                print(f"{key}: bytes_list with length {len(feature.bytes_list.value)}")
            else:
                print(f"{key}: unknown type")

# Call the function with your file path
inspect_tfrecord('data/next_day_wildfire_spread_train_00.tfrecord')
