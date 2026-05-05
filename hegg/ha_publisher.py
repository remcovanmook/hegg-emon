"""
hegg.ha_publisher
=================

Home Assistant integration via MQTT auto-discovery.

This module publishes Hegg energy monitor readings to an MQTT broker so
that Home Assistant can auto-discover them as sensor entities via its
`MQTT discovery <https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery>`_
mechanism.  No manual configuration in Home Assistant is required beyond
having the MQTT integration enabled.

Entities created
----------------

Each entity is created under the device ``hegg_<serial>`` with the
following ``unique_id`` / entity names:

=================================  ====================  ========
Entity ID suffix                   Unit / class          Label
=================================  ====================  ========
power_delivered                    kW / power            Grid power in
power_returned                     kW / power            Grid power out
voltage_l1 / voltage_l2 / l3      V / voltage           Voltage L1–L3
current_l1 / current_l2 / l3      A / current           Current L1–L3
=================================  ====================  ========

Configuration
-------------

Pass an :class:`MQTTConfig` to :class:`HAPublisher`, then register
:meth:`HAPublisher.handle` as a listener callback::

    from hegg.ha_publisher import HAPublisher, MQTTConfig

    cfg = MQTTConfig(host="192.168.1.10", username="mqtt", password="secret")
    publisher = HAPublisher(cfg)
    await publisher.connect()

    listener = HeggListener()
    listener.add_handler(publisher.handle)
    asyncio.run(listener.run())

Dependencies
------------

This module requires ``aiohttp`` for the async MQTT client.  The actual
MQTT transport is handled by ``aiomqtt`` which must be installed alongside::

    pip install aiomqtt
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import aiomqtt  # type: ignore
    _AIOMQTT_AVAILABLE = True
except ImportError:
    _AIOMQTT_AVAILABLE = False
    logger.warning(
        "aiomqtt not installed — HAPublisher will not function. "
        "Install with: pip install aiomqtt"
    )

from hegg.reading import HeggReading

#: MQTT topic prefix for Home Assistant discovery.
HA_DISCOVERY_PREFIX: str = "homeassistant"

#: MQTT topic prefix for state updates.
HEGG_STATE_PREFIX: str = "hegg"


@dataclass
class MQTTConfig:
    """Connection parameters for the MQTT broker.

    Attributes:
        host:       Hostname or IP of the MQTT broker.
        port:       TCP port (default: 1883).
        username:   Optional broker username.
        password:   Optional broker password.
        tls:        Whether to use TLS (default: False).
        keepalive:  MQTT keepalive interval in seconds.
    """

    host: str
    port: int = 1883
    username: Optional[str] = None
    password: Optional[str] = None
    tls: bool = False
    keepalive: int = 60


# Sensor definitions: (field_attr, name, unit_of_measurement, device_class, state_class)
_SENSORS = [
    ("power_delivered", "Power Delivered", "kW",  "power",   "measurement"),
    ("power_returned",  "Power Returned",  "kW",  "power",   "measurement"),
    ("voltage_l1",      "Voltage L1",      "V",   "voltage", "measurement"),
    ("voltage_l2",      "Voltage L2",      "V",   "voltage", "measurement"),
    ("voltage_l3",      "Voltage L3",      "V",   "voltage", "measurement"),
    ("current_l1",      "Current L1",      "A",   "current", "measurement"),
    ("current_l2",      "Current L2",      "A",   "current", "measurement"),
    ("current_l3",      "Current L3",      "A",   "current", "measurement"),
]


class HAPublisher:
    """Publishes Hegg readings to Home Assistant via MQTT auto-discovery.

    On the first received reading (or on explicit :meth:`publish_discovery`)
    the entity configuration messages are sent so Home Assistant can create
    the sensor entities.  Subsequent readings update the state topics only.

    Args:
        config:              MQTT connection configuration.
        discovery_prefix:    Home Assistant discovery topic prefix
                             (default: ``homeassistant``).
    """

    def __init__(
        self,
        config: MQTTConfig,
        discovery_prefix: str = HA_DISCOVERY_PREFIX,
    ) -> None:
        if not _AIOMQTT_AVAILABLE:
            raise RuntimeError(
                "aiomqtt is required for HAPublisher. Install with: pip install aiomqtt"
            )
        self._config = config
        self._discovery_prefix = discovery_prefix
        self._client: Optional["aiomqtt.Client"] = None
        self._discovery_sent: bool = False
        self._serial: Optional[str] = None

    async def connect(self) -> None:
        """Establish connection to the MQTT broker.

        Must be called before the listener loop starts, ideally inside an
        async context where the event loop is already running.

        Raises:
            aiomqtt.MqttError: On connection failure.
        """
        kwargs = {
            "hostname": self._config.host,
            "port": self._config.port,
            "keepalive": self._config.keepalive,
        }
        if self._config.username:
            kwargs["username"] = self._config.username
        if self._config.password:
            kwargs["password"] = self._config.password
        if self._config.tls:
            kwargs["tls_context"] = True

        self._client = aiomqtt.Client(**kwargs)
        await self._client.__aenter__()
        logger.info("Connected to MQTT broker at %s:%d", self._config.host, self._config.port)

    async def disconnect(self) -> None:
        """Gracefully disconnect from the MQTT broker."""
        if self._client is not None:
            await self._client.__aexit__(None, None, None)
            self._client = None
            logger.info("Disconnected from MQTT broker")

    async def publish_discovery(self, serial: str) -> None:
        """Send HA MQTT discovery config messages for all sensor entities.

        This is called automatically on the first received reading.
        Re-calling it with the same serial is idempotent.

        Args:
            serial: Device serial string (used as unique device identifier).
        """
        if self._client is None:
            raise RuntimeError("Not connected to MQTT broker — call connect() first")

        device_id = f"hegg_{serial}"
        device_payload = {
            "identifiers": [device_id],
            "name": "Hegg Energy Monitor",
            "model": "Hegg",
            "manufacturer": "Hegg",
            "serial_number": serial,
        }

        for field_name, friendly_name, unit, dev_class, state_class in _SENSORS:
            unique_id = f"{device_id}_{field_name}"
            state_topic = f"{HEGG_STATE_PREFIX}/{serial}/state"
            config_topic = f"{self._discovery_prefix}/sensor/{device_id}/{field_name}/config"

            config_payload = {
                "name": friendly_name,
                "unique_id": unique_id,
                "state_topic": state_topic,
                "value_template": f"{{{{ value_json.{field_name} }}}}",
                "unit_of_measurement": unit,
                "device_class": dev_class,
                "state_class": state_class,
                "device": device_payload,
            }

            await self._client.publish(
                config_topic,
                payload=json.dumps(config_payload),
                retain=True,
                qos=1,
            )
            logger.debug("Published HA discovery config for %s", unique_id)

        logger.info("Published MQTT discovery for %d sensors (serial=%s)", len(_SENSORS), serial)

    async def handle(self, reading: HeggReading) -> None:
        """Publish a reading to MQTT.

        Sends discovery config on the first call, then publishes the state
        JSON to the per-device state topic on every call.

        Args:
            reading: Parsed reading from the Hegg device.
        """
        if self._client is None:
            logger.warning("MQTT client not connected — dropping reading")
            return

        if not self._discovery_sent or self._serial != reading.serial:
            await self.publish_discovery(reading.serial)
            self._serial = reading.serial
            self._discovery_sent = True

        state_topic = f"{HEGG_STATE_PREFIX}/{reading.serial}/state"
        await self._client.publish(
            state_topic,
            payload=json.dumps(reading.to_dict()),
            qos=0,
        )
        logger.debug("Published state to %s", state_topic)
