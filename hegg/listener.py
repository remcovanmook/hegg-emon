"""
hegg.listener
=============

Async UDP listener for the Hegg energy monitor broadcast protocol.

The device broadcasts a JSON payload once per second on UDP port 16121
(destination 255.255.255.255, or the subnet broadcast address).  This
module provides an asyncio-based listener that parses each packet and
dispatches the parsed :class:`HeggReading` to any number of registered
callback coroutines.

Typical usage::

    async def my_handler(reading: HeggReading) -> None:
        print(reading.power_returned)

    listener = HeggListener(port=16121)
    listener.add_handler(my_handler)
    await listener.run()
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, List, Optional

logger = logging.getLogger(__name__)

#: Default UDP port the Hegg device broadcasts on.
DEFAULT_PORT: int = 16121

#: Type alias for an async callback that receives a parsed reading.
HandlerFn = Callable[["HeggReading"], Awaitable[None]]


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
        power_returned:  Power being fed back to the grid (kW, solar etc.).
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

        Raises:
            KeyError:  If a required field is absent from *data*.
            ValueError: If the timestamp string cannot be parsed.
        """
        ts = datetime.fromisoformat(data["timestamp"].rstrip("Z") + "+00:00")
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
            "timestamp": self.timestamp.isoformat(),
            "serial": self.serial,
            "power_delivered": self.power_delivered,
            "power_returned": self.power_returned,
            "voltage_l1": self.voltage_l1,
            "voltage_l2": self.voltage_l2,
            "voltage_l3": self.voltage_l3,
            "current_l1": self.current_l1,
            "current_l2": self.current_l2,
            "current_l3": self.current_l3,
        }


class _HeggProtocol(asyncio.DatagramProtocol):
    """Low-level asyncio datagram protocol that bridges UDP → coroutines.

    Constructed internally by :class:`HeggListener`.  Each incoming
    datagram is parsed immediately on the event-loop thread; callbacks are
    then scheduled as tasks so slow handlers cannot block packet receipt.
    """

    def __init__(self, handlers: List[HandlerFn], loop: asyncio.AbstractEventLoop) -> None:
        self._handlers = handlers
        self._loop = loop

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        """Called by asyncio for every incoming UDP datagram.

        Args:
            data: Raw datagram payload bytes.
            addr: ``(host, port)`` of the sender.
        """
        try:
            payload = json.loads(data.decode("utf-8"))
            reading = HeggReading.from_dict(payload)
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            logger.warning("Dropping malformed packet from %s: %s", addr, exc)
            return

        logger.debug("Received reading from %s: %r", addr, reading)

        for handler in self._handlers:
            self._loop.create_task(handler(reading))

    def error_received(self, exc: Optional[Exception]) -> None:
        """Called by asyncio on non-fatal socket errors."""
        logger.error("UDP socket error: %s", exc)


class HeggListener:
    """Async UDP listener for the Hegg energy monitor broadcast.

    Binds to *host*:*port* and dispatches parsed :class:`HeggReading`
    objects to all registered handler coroutines.

    Example::

        listener = HeggListener()
        listener.add_handler(my_async_handler)
        asyncio.run(listener.run())

    Args:
        host: Address to bind to.  ``""`` (default) binds to all
              interfaces, which is required to receive broadcasts.
        port: UDP port to listen on (default: :data:`DEFAULT_PORT`).
    """

    def __init__(self, host: str = "", port: int = DEFAULT_PORT) -> None:
        self._host = host
        self._port = port
        self._handlers: List[HandlerFn] = []
        self._transport: Optional[asyncio.DatagramTransport] = None

    def add_handler(self, fn: HandlerFn) -> None:
        """Register *fn* as an async callback for every new reading.

        Args:
            fn: An ``async def`` coroutine function that accepts a single
                :class:`HeggReading` argument.
        """
        self._handlers.append(fn)

    async def run(self) -> None:
        """Bind the UDP socket and listen indefinitely.

        This coroutine never returns under normal operation.  Cancel the
        task or send SIGINT to stop.
        """
        loop = asyncio.get_running_loop()
        logger.info("Binding UDP listener on %s:%s", self._host or "*", self._port)

        transport, _ = await loop.create_datagram_endpoint(
            lambda: _HeggProtocol(self._handlers, loop),
            local_addr=(self._host, self._port),
            allow_broadcast=True,
        )
        self._transport = transport

        try:
            await asyncio.Future()  # run forever
        finally:
            transport.close()
            logger.info("UDP listener stopped")
