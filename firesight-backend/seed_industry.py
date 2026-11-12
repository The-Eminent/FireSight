#!/usr/bin/env python3
"""Replace industriallocations with authoritative US industrial heat sources."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from pymongo import GEOSPHERE, MongoClient
except ImportError as exc:
    raise SystemExit(
        "pymongo is required: ml/venv/bin/pip install pymongo"
    ) from exc

EPA_YEAR = 2023  # Latest complete year currently exposed by EPA Envirofacts.
EPA_URL = "https://data.epa.gov/efservice/rlps_ghg_emitter_facilities"
FLARE_URL = (
    "https://eogdata.mines.edu/global_flare_data/"
    "2023_flare_summary_v20240314_npp.kml"
)
CONUS = (-125.0, 24.0, -66.0, 49.5)
NAICS = {
    "324110": ("refinery", "petroleum refinery"),
    "325110": ("manufacturing", "petrochemical manufacturing"),
    "325180": ("manufacturing", "basic inorganic chemical manufacturing"),
    "325199": ("manufacturing", "basic organic chemical manufacturing"),
    "327310": ("manufacturing", "cement manufacturing"),
    "331110": ("manufacturing", "iron and steel mill"),
    "331313": ("manufacturing", "alumina/aluminum production"),
    "331314": ("manufacturing", "secondary aluminum production"),
    "331410": ("manufacturing", "nonferrous metal production"),
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "FireSight/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def in_conus(longitude: float, latitude: float) -> bool:
    west, south, east, north = CONUS
    return west <= longitude <= east and south <= latitude <= north


def base_document(
    source_id: str,
    name: str,
    longitude: float,
    latitude: float,
    category: str,
    source: str,
    radius_meters: int,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return {
        "sourceId": source_id,
        "name": name,
        "type": category,
        "category": category,
        "source": source,
        "location": {"type": "Point", "coordinates": [longitude, latitude]},
        "radiusMeters": radius_meters,
        "active": True,
        "metadata": {"type": category, **metadata},
        "synchronizedAt": datetime.now(timezone.utc),
    }


def load_epa_facilities() -> list[dict[str, Any]]:
    documents = []
    for naics, (category, description) in NAICS.items():
        url = f"{EPA_URL}/year/{EPA_YEAR}/primary_naics/{naics}/rows/0:9999/json"
        for facility in json.loads(fetch(url)):
            try:
                latitude = float(facility["latitude"])
                longitude = float(facility["longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if not in_conus(longitude, latitude):
                continue
            facility_id = str(facility["facility_id"])
            documents.append(base_document(
                f"EPA_GHGRP:{facility_id}",
                facility.get("facility_name") or f"EPA facility {facility_id}",
                longitude,
                latitude,
                category,
                f"EPA_GHGRP_{EPA_YEAR}",
                250,
                {
                    "industry": description,
                    "naics": naics,
                    "reportingYear": EPA_YEAR,
                    "city": facility.get("city"),
                    "state": facility.get("state"),
                    "sourceUrl": url,
                },
            ))
    return documents


def load_viirs_flares() -> list[dict[str, Any]]:
    root = ET.fromstring(fetch(FLARE_URL))
    namespace = {"kml": "http://www.opengis.net/kml/2.2"}
    documents = []
    for placemark in root.findall(".//kml:Placemark", namespace):
        name = placemark.findtext("kml:name", default="Unnamed flare", namespaces=namespace)
        description = placemark.findtext("kml:description", default="", namespaces=namespace)
        if "Country: <b>USA</b>" not in description and not name.startswith("USA_"):
            continue
        coordinates = placemark.findtext(".//kml:coordinates", namespaces=namespace)
        if not coordinates:
            continue
        try:
            longitude, latitude = map(float, coordinates.strip().split(",")[:2])
        except ValueError:
            continue
        if not in_conus(longitude, latitude):
            continue
        volume = re.search(r"BCM_total=([0-9.]+)", description)
        flare_type = re.search(r"Type:\s*([^<]+)", description)
        source_id = f"EOG_VIIRS_2023:{longitude:.6f}:{latitude:.6f}"
        documents.append(base_document(
            source_id,
            f"Persistent gas flare {name}",
            longitude,
            latitude,
            "flare",
            "EOG_VIIRS_FLARE_2023",
            500,
            {
                "flareType": flare_type.group(1).strip() if flare_type else None,
                "annualBcm": float(volume.group(1)) if volume else None,
                "sourceUrl": FLARE_URL,
            },
        ))
    return documents


def read_dotenv_value(name: str) -> str | None:
    env_file = Path(__file__).with_name(".env")
    if not env_file.exists():
        return None
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip("\"'")
    return None


def seed(documents: list[dict[str, Any]], mongo_uri: str) -> tuple[int, int, str]:
    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=10_000)
    client.admin.command("ping")
    database = client.get_default_database(default="wildfire_db")
    collection = database["industriallocations"]
    deleted = collection.delete_many({}).deleted_count
    inserted = len(collection.insert_many(documents, ordered=False).inserted_ids)
    collection.create_index([("location", GEOSPHERE)], name="location_2dsphere")
    index = collection.index_information().get("location_2dsphere")
    if not index or index.get("key") != [("location", "2dsphere")]:
        raise RuntimeError("location_2dsphere index verification failed")
    client.close()
    return deleted, inserted, database.name


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate without writing MongoDB")
    args = parser.parse_args()

    print("Fetching EPA GHGRP industrial facilities...")
    documents = load_epa_facilities()
    print("Fetching VIIRS-observed gas flare locations...")
    documents.extend(load_viirs_flares())
    unique = {document["sourceId"]: document for document in documents}
    documents = list(unique.values())
    if not documents:
        raise RuntimeError("No valid industrial locations were generated; MongoDB was not changed")

    categories = Counter(document["category"] for document in documents)
    print(f"Validated {len(documents)} unique CONUS locations: {dict(categories)}")
    if args.dry_run:
        print("Dry run complete; MongoDB was not changed.")
        return

    mongo_uri = os.environ.get("MONGODB_URI") or read_dotenv_value("MONGODB_URI")
    if not mongo_uri:
        mongo_uri = "mongodb://localhost:27017/wildfire_db"
    deleted, inserted, database = seed(documents, mongo_uri)
    print("=== Industrial blacklist seed report ===")
    print(f"Database: {database}; collection: industriallocations")
    print(f"Previous records removed: {deleted}")
    print(f"Records inserted: {inserted}")
    print("Verified index: location_2dsphere")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Industrial blacklist seed failed: {error}", file=sys.stderr)
        raise SystemExit(1)
