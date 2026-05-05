"""
hegg.reading
============

Core data model for a single Hegg energy monitor reading.

This module is intentionally dependency-free so it can be imported by
any part of the codebase without pulling in asyncio, Flask, or SQLite.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional  # noqa: F401 — re-exported for callers


@dataclass
class HeggReading:
    """A single parsed reading from the Hegg energy monitor.

    All power values are in kilowatts (kW), voltages in volts (V), and
    currents in amperes (A), matching the raw JSON field names the device
    emits.

    Attributes:
        timestamp:       UTC timestamp as reported by the device.
        serial:          Hardware serial / MAC-derived identifier.
        power_delivered: Grid power currently being consumed (kW).
        power_returned:  Power being fed back to the grid (kW).
        voltage_l1:      RMS voltage on phase L1 (V).
        voltage_l2:      RMS voltage on phase L2 (V).
        voltage_l3:      RMS voltage on phase L3 (V).
        current_l1:      RMS current on phase L1 (A).
        current_l2:      RMS current on phase L2 (A).
        current_l3:      RMS current on phase L3 (A).
        received_at:     Local wall-clock time this packet was received.
    """

    timestamp: datetime
    serial: str
    power_delivered: float
    power_returned: float
    voltage_l1: float
    voltage_l2: float
    voltage_l3: float
    current_l1: float
    current_l2: float
    current_l3: float
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @classmethod
    def from_dict(cls, data: dict) -> "HeggReading":
        """Construct a :class:`HeggReading` from a raw parsed JSON dict.

        Handles both ``Z``-suffixed and ``+00:00``-suffixed ISO 8601 timestamps.

        Args:
            data: Dict with keys matching the Hegg device JSON payload.

        Raises:
            KeyError:   If a required field is absent from *data*.
            ValueError: If the timestamp string cannot be parsed.
        """
        ts_raw = data["timestamp"]
        # Normalise: strip trailing Z, ensure +00:00 suffix.
        if ts_raw.endswith("Z"):
            ts_raw = ts_raw[:-1] + "+00:00"
        ts = datetime.fromisoformat(ts_raw)
        return cls(
            timestamp=ts,
            serial=data["serial"],
            power_delivered=float(data["power_delivered"]),
            power_returned=float(data["power_returned"]),
            voltage_l1=float(data["voltage_l1"]),
            voltage_l2=float(data["voltage_l2"]),
            voltage_l3=float(data["voltage_l3"]),
            current_l1=float(data["current_l1"]),
            current_l2=float(data["current_l2"]),
            current_l3=float(data["current_l3"]),
        )

    def to_dict(self) -> dict:
        """Return a JSON-serialisable representation of this reading."""
        return {
            "timestamp":       self.timestamp.isoformat(),
            "serial":          self.serial,
            "power_delivered": self.power_delivered,
            "power_returned":  self.power_returned,
            "voltage_l1": self.voltage_l1,
            "voltage_l2": self.voltage_l2,
            "voltage_l3": self.voltage_l3,
            "current_l1": self.current_l1,
            "current_l2": self.current_l2,
            "current_l3": self.current_l3,
        }
