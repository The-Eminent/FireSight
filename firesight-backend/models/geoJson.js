function coordinateValidator(value) {
  return Array.isArray(value) && value.length === 2 &&
    Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 &&
    Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
}

function pointField(required = true) {
  return {
    type: {
      type: String,
      enum: ['Point'],
      required,
      default: required ? 'Point' : undefined
    },
    coordinates: {
      type: [Number],
      required,
      default: undefined,
      validate: {
        validator: value => !required && value == null || coordinateValidator(value),
        message: 'GeoJSON Point coordinates must be [longitude, latitude]'
      }
    }
  };
}

function polygonField(required = true) {
  return {
    type: {
      type: String,
      enum: ['Polygon', 'MultiPolygon'],
      required
    },
    coordinates: { type: Array, required }
  };
}

module.exports = { pointField, polygonField };
