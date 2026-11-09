import numpy as np
import joblib
import math
import json
import sys
import os
import requests
from datetime import datetime

# Determine script directory (models are in the same folder)
script_dir = os.path.dirname(os.path.abspath(__file__))

# Load models from the same directory as this script
classifier = joblib.load(os.path.join(script_dir, "wildfire_spread_classifier_advanced.joblib"))
regressor = joblib.load(os.path.join(script_dir, "wildfire_spread_regressor_advanced.joblib"))

def get_weather_data(lat, lng):
    """Fetch real weather data for the fire location"""
    try:
        # Using Open-Meteo API (free, no key required)
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"
        response = requests.get(url, timeout=5)
        data = response.json()
        
        if 'current' in data:
            return {
                'temp_max': data['current']['temperature_2m'],
                'humidity': data['current']['relative_humidity_2m'],
                'wind_speed': data['current']['wind_speed_10m'],
                'wind_direction': data['current']['wind_direction_10m']
            }
    except Exception as e:
        print(f"Weather API error: {e}")
    
    # Return None if API call fails
    return None

def get_elevation_data(lat, lng):
    """Fetch elevation data for the fire location"""
    try:
        # Using Open-Meteo Elevation API
        url = f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lng}"
        response = requests.get(url, timeout=5)
        data = response.json()
        
        if 'elevation' in data and len(data['elevation']) > 0:
            return data['elevation'][0]
    except Exception as e:
        print(f"Elevation API error: {e}")
    
    # Return default if API call fails
    return 500

def get_drought_vegetation(lat, lng):
    """Generate realistic drought and vegetation values based on location and season"""
    # Get current month to estimate seasonal factors
    current_month = datetime.now().month
    
    # US regions with different climate patterns
    west_coast = lng < -115
    southwest = lng < -100 and lat < 37
    southeast = lng > -90 and lat < 36
    northeast = lng > -80 and lat > 36
    
    # Base drought index (0-5 scale, higher = more drought)
    if west_coast:
        # West coast - dry in summer, wet in winter
        base_drought = 4.0 if 5 <= current_month <= 10 else 2.0
    elif southwest:
        # Southwest - generally dry
        base_drought = 3.5
    elif southeast:
        # Southeast - humid but can have drought
        base_drought = 2.5
    elif northeast:
        # Northeast - less drought prone
        base_drought = 1.5
    else:
        # Central US
        base_drought = 2.0
    
    # Add randomness (±1.0)
    drought = max(0, min(5, base_drought + (np.random.random() * 2 - 1)))
    
    # Vegetation index (0-1 scale, higher = more vegetation)
    # Inversely related to drought but with regional factors
    if west_coast:
        base_veg = 0.4
    elif southwest:
        base_veg = 0.3
    elif southeast:
        base_veg = 0.7
    elif northeast:
        base_veg = 0.6
    else:
        base_veg = 0.5
    
    # Seasonal adjustment
    if 3 <= current_month <= 8:  # Spring/Summer
        base_veg += 0.2
    
    # Adjust for drought (inverse relationship)
    veg_adjusted = base_veg * (1 - (drought / 7))
    
    # Add randomness (±0.15)
    vegetation = max(0.1, min(0.9, veg_adjusted + (np.random.random() * 0.3 - 0.15)))
    
    return drought, vegetation

def predict_fire_spread(fire_data):
    """Predict fire spread using both classifier and regressor models."""
    # Required inputs: latitude and longitude
    lat = fire_data.get('lat')
    lng = fire_data.get('lng')
    brightness = fire_data.get('brightness', 350)
    
    # Get real weather data if possible
    weather = get_weather_data(lat, lng)
    
    # Use real data or reasonable defaults based on location
    if weather:
        temp_max = weather['temp_max']
        humidity = weather['humidity']
        wind_speed = weather['wind_speed']
        wind_dir = weather['wind_direction']
        temp_min = temp_max - 10  # Estimate min temp as 10°C below max
        data_source = "weather_api"
    else:
        # Generate semi-random values that make sense together
        # Higher brightness often correlates with hotter, drier conditions
        temp_factor = min(1.0, brightness / 400)  # Normalize brightness
        temp_max = 20 + (temp_factor * 15) + (np.random.random() * 5)  # 20-40°C
        temp_min = temp_max - 10  # Estimate min temp
        humidity = max(10, 60 - (temp_factor * 40) + (np.random.random() * 10))  # 10-60%
        wind_speed = 5 + (np.random.random() * 20)  # 5-25 km/h
        wind_dir = np.random.randint(0, 360)  # Random direction
        data_source = "estimated"
    
    # Get elevation
    elevation = get_elevation_data(lat, lng)
    
    # Get drought and vegetation indices
    drought, vegetation = get_drought_vegetation(lat, lng)
    
    # Use brightness to estimate fire intensity
    fire_intensity = brightness
    
    # Build feature vector (must match training order)
    features = [
        elevation, elevation,
        wind_dir, wind_dir,
        wind_speed, wind_speed,
        temp_min, temp_min,
        temp_max, temp_max,
        humidity, humidity,
        drought, drought,
        vegetation, vegetation,
        fire_intensity, fire_intensity / 100.0,
        wind_speed * math.cos(math.radians(wind_dir)),
        wind_speed * math.sin(math.radians(wind_dir)),
        elevation * wind_speed,
        drought * vegetation,
        1.0  # default shape ratio placeholder
    ]
    X = np.array(features).reshape(1, -1)

    # Classifier prediction
    will_spread = bool(classifier.predict(X)[0])
    spread_prob = float(classifier.predict_proba(X)[0][1])

    # Regressor prediction (clipped)
    raw_ratio = float(regressor.predict(X)[0])
    spread_ratio = max(0.1, min(10.0, raw_ratio))

    # Visualization parameters
    wind_angle = math.radians((270 - wind_dir) % 360)
    
    # Higher brightness and wind speed increase base distance
    brightness_factor = min(1.5, brightness / 350)
    wind_factor = min(1.5, wind_speed / 10)
    base_km = 1.0 * brightness_factor * wind_factor
    spread_km = base_km * spread_ratio

    # Generate polygon points
    pts = []
    for i in range(8):
        angle = wind_angle + (i * 2 * math.pi / 8)
        
        # Distance varies by direction (further in wind direction)
        direction_factor = 0.5 + 0.5 * math.cos(angle - wind_angle)
        
        # Terrain effect: uphill spread is faster
        terrain_factor = 1.0
        
        # Vegetation effect: denser vegetation = faster spread
        veg_factor = 0.7 + (vegetation * 0.6)
        
        # Combined factors
        d = spread_km * direction_factor * terrain_factor * veg_factor
        
        lat_off = d / 111.32
        lng_off = d / (111.32 * math.cos(math.radians(lat)))
        pts.append({
            "lat": lat + lat_off * math.sin(angle),
            "lng": lng + lng_off * math.cos(angle),
            "probability": spread_prob * direction_factor
        })

    # Compose GeoJSON
    features_geo = []
    # Origin point
    features_geo.append({
        "type": "Feature",
        "properties": {"type": "origin", "intensity": fire_intensity},
        "geometry": {"type": "Point", "coordinates": [lng, lat]}
    })
    # Spread polygon
    coords = [[lng, lat]] + [[p['lng'], p['lat']] for p in pts] + [[lng, lat]]
    features_geo.append({
        "type": "Feature",
        "properties": {
            "type": "spread",
            "will_spread": int(will_spread),
            "probability": spread_prob,
            "spread_ratio": spread_ratio,
            "spread_distance_km": spread_km,
            "wind_direction": wind_dir
        },
        "geometry": {"type": "Polygon", "coordinates": [coords]}
    })
    # Direction arrow
    arrow_end = [
        lng + math.cos(wind_angle) * spread_km / (111.32 * math.cos(math.radians(lat))),
        lat + math.sin(wind_angle) * spread_km / 111.32
    ]
    features_geo.append({
        "type": "Feature",
        "properties": {"type": "direction", "direction": wind_dir, "probability": spread_prob},
        "geometry": {"type": "LineString", "coordinates": [[lng, lat], arrow_end]}
    })
    # Individual spread points
    for idx, p in enumerate(pts):
        features_geo.append({
            "type": "Feature",
            "properties": {"type": "spread_point", "probability": p['probability'], "index": idx},
            "geometry": {"type": "Point", "coordinates": [p['lng'], p['lat']]}  
        })

    # Include the environmental data used in the prediction for transparency
    env_data = {
        "elevation": elevation,
        "wind_direction": wind_dir,
        "wind_speed": wind_speed,
        "temperature": temp_max,
        "humidity": humidity,
        "drought": drought,
        "vegetation": vegetation,
        "brightness": brightness,
        "data_source": data_source
    }

    return {
        "will_spread": will_spread,
        "spread_probability": spread_prob,
        "spread_ratio": spread_ratio,
        "spread_direction": wind_dir,
        "spread_distance_km": spread_km,
        "environmental_data": env_data,
        "geojson": {"type": "FeatureCollection", "features": features_geo}
    }

if __name__ == "__main__":
    fire_data = json.loads(sys.argv[1])
    result = predict_fire_spread(fire_data)
    print(json.dumps(result))
