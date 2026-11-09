"""Rothermel rate-of-spread baseline for the MVP Fuel Model 4 assumption."""

from __future__ import annotations

from dataclasses import dataclass
from math import atan2, cos, degrees, exp, hypot, isfinite, radians, sin


# Anderson Fuel Model 4 (chaparral): loads are lb/ft2, SAV is ft2/ft3.
LOADS = (0.230, 0.184, 0.092, 0.0, 0.230)
SAV = (2000.0, 109.0, 30.0, 0.0, 1500.0)
MOISTURE = (0.06, 0.07, 0.08, 0.30, 0.60)  # USDA D2L1 scenario
HEAT = (8000.0,) * 5  # Btu/lb
FUEL_DEPTH_FT = 6.0
DEAD_MOISTURE_OF_EXTINCTION = 0.20
WIND_ADJUSTMENT_FACTOR = 0.55
PARTICLE_DENSITY = 32.0
TOTAL_MINERAL = 0.0555
EFFECTIVE_MINERAL = 0.01
METERS_PER_FOOT = 0.3048
FEET_PER_MINUTE_PER_M_S = 196.850394


@dataclass(frozen=True)
class RothermelResult:
    """Head-fire result in local metric coordinates."""

    rate_m_min: float
    heading_degrees: float
    distance_24h_m: float
    wind_factor: float
    slope_factor: float


def _weighted(values: tuple[float, ...], fractions: tuple[float, ...]) -> float:
    return sum(value * fraction for value, fraction in zip(values, fractions))


def _fuel_terms() -> tuple[float, float, float, float]:
    areas = tuple(sav * load / PARTICLE_DENSITY for sav, load in zip(SAV, LOADS))
    dead_area, live_area = sum(areas[:3]), sum(areas[3:])
    total_area = dead_area + live_area
    dead_f = tuple(area / dead_area for area in areas[:3])
    live_f = tuple(area / live_area for area in areas[3:])
    dead_share, live_share = dead_area / total_area, live_area / total_area

    net_loads = tuple(load * (1.0 - TOTAL_MINERAL) for load in LOADS)
    net_dead = _weighted(net_loads[:3], dead_f)
    # This follows Behave/Rothermel's treatment of the live fuel classes.
    net_live = sum(net_loads[3:])
    moisture_dead = _weighted(MOISTURE[:3], dead_f)
    moisture_live = _weighted(MOISTURE[3:], live_f)
    sigma_dead = _weighted(SAV[:3], dead_f)
    sigma_live = _weighted(SAV[3:], live_f)
    sigma = dead_share * sigma_dead + live_share * sigma_live
    heat_dead = _weighted(HEAT[:3], dead_f)
    heat_live = _weighted(HEAT[3:], live_f)

    dead_weight = sum(LOADS[i] * exp(-138.0 / SAV[i]) for i in range(3))
    live_weight = sum(
        LOADS[i] * exp(-500.0 / SAV[i])
        for i in range(3, 5) if LOADS[i] > 0.0
    )
    fine_dead_moisture = sum(
        LOADS[i] * MOISTURE[i] * exp(-138.0 / SAV[i]) for i in range(3)
    ) / dead_weight
    live_extinction = max(
        DEAD_MOISTURE_OF_EXTINCTION,
        2.9 * (dead_weight / live_weight)
        * (1.0 - fine_dead_moisture / DEAD_MOISTURE_OF_EXTINCTION) - 0.226,
    )

    def damping(moisture: float, extinction: float) -> float:
        if moisture >= extinction:
            return 0.0
        ratio = moisture / extinction
        return 1.0 - 2.59 * ratio + 5.11 * ratio**2 - 3.52 * ratio**3

    mineral_damping = 0.174 * EFFECTIVE_MINERAL**-0.19
    packing = sum(load / PARTICLE_DENSITY for load in LOADS) / FUEL_DEPTH_FT
    optimum_packing = 3.348 * sigma**-0.8189
    relative_packing = packing / optimum_packing
    gamma_max = sigma**1.5 / (495.0 + 0.0594 * sigma**1.5)
    gamma = gamma_max * (relative_packing * exp(1.0 - relative_packing)) ** (
        133.0 * sigma**-0.7913
    )
    reaction = gamma * mineral_damping * (
        net_dead * heat_dead * damping(moisture_dead, DEAD_MOISTURE_OF_EXTINCTION)
        + net_live * heat_live * damping(moisture_live, live_extinction)
    )
    flux = exp((0.792 + 0.681 * sigma**0.5) * (packing + 0.1)) / (
        192.0 + 0.2595 * sigma
    )
    bulk_density = sum(LOADS) / FUEL_DEPTH_FT
    ignition_heat = tuple(250.0 + 1116.0 * moisture for moisture in MOISTURE)
    heat_sink = dead_share * sum(
        dead_f[i] * ignition_heat[i] * exp(-138.0 / SAV[i]) for i in range(3)
    ) + live_share * sum(
        live_f[i - 3] * ignition_heat[i] * exp(-138.0 / SAV[i])
        for i in range(3, 5) if live_f[i - 3] > 0.0
    )
    base_rate_m_min = reaction * flux / (bulk_density * heat_sink) * METERS_PER_FOOT
    return base_rate_m_min, sigma, relative_packing, packing


BASE_RATE_M_MIN, CHARACTERISTIC_SAV, RELATIVE_PACKING, PACKING = _fuel_terms()


def fuel_model_4_ros(
    wind_speed_m_s: float,
    wind_from_degrees: float,
    slope_east: float = 0.0,
    slope_north: float = 0.0,
) -> RothermelResult:
    """Calculate Fuel Model 4 head spread from 10 m wind and terrain gradient.

    ``wind_from_degrees`` follows the meteorological convention (clockwise
    from north). Slope components are rise/run toward east and north.
    """
    if not all(isfinite(value) for value in (
        wind_speed_m_s, wind_from_degrees, slope_east, slope_north
    )):
        raise ValueError("Rothermel inputs must be finite")
    if wind_speed_m_s < 0:
        raise ValueError("wind speed cannot be negative")

    midflame_ft_min = (
        wind_speed_m_s * WIND_ADJUSTMENT_FACTOR * FEET_PER_MINUTE_PER_M_S
    )
    wind_c = 7.47 * exp(-0.133 * CHARACTERISTIC_SAV**0.55)
    wind_b = 0.02526 * CHARACTERISTIC_SAV**0.54
    wind_e = 0.715 * exp(-0.000359 * CHARACTERISTIC_SAV)
    wind_factor = (
        wind_c * midflame_ft_min**wind_b * RELATIVE_PACKING**-wind_e
        if midflame_ft_min > 0 else 0.0
    )
    slope = hypot(slope_east, slope_north)
    slope_factor = 5.275 * PACKING**-0.3 * slope**2

    downwind = (wind_from_degrees + 180.0) % 360.0
    wind_east = wind_factor * sin(radians(downwind))
    wind_north = wind_factor * cos(radians(downwind))
    if slope:
        slope_heading = degrees(atan2(slope_east, slope_north)) % 360.0
        slope_east_factor = slope_factor * slope_east / slope
        slope_north_factor = slope_factor * slope_north / slope
    else:
        slope_heading = downwind
        slope_east_factor = slope_north_factor = 0.0
    combined_east = wind_east + slope_east_factor
    combined_north = wind_north + slope_north_factor
    combined_factor = hypot(combined_east, combined_north)
    heading = (
        degrees(atan2(combined_east, combined_north)) % 360.0
        if combined_factor else slope_heading
    )
    rate = BASE_RATE_M_MIN * (1.0 + combined_factor)
    return RothermelResult(
        rate_m_min=rate,
        heading_degrees=heading,
        distance_24h_m=rate * 24.0 * 60.0,
        wind_factor=wind_factor,
        slope_factor=slope_factor,
    )
