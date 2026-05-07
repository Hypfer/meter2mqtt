const mqtt = require("mqtt");
const Logger = require("./Logger");

class MqttBatteryState {
    constructor() {
        this.batteries = new Map();
        this.idToMac = new Map();
        this.client = null;

        // Configuration
        this.brokerUrl = process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1";
        this.freshFull = parseInt(process.env.MQTT_FRESH_FULL) || 60;
        this.freshDead = parseInt(process.env.MQTT_FRESH_DEAD) || 90;

        // Parse BATTERY_MAP=One:mac1,Two:mac2
        this.parseBatteryMap();
    }

    parseBatteryMap() {
        const mapStr = process.env.BATTERY_MAP;
        if (!mapStr) {
            Logger.warn("BATTERY_MAP not set — SoC-aware steering disabled");
            return;
        }

        const pairs = mapStr.split(",");
        for (const pair of pairs) {
            const [id, mac] = pair.split(":").map(s => s.trim());
            if (id && mac) {
                this.idToMac.set(id.toLowerCase(), mac.toLowerCase());
                this.batteries.set(mac.toLowerCase(), {
                    soc: null,
                    batteryPower: 0,
                    setChargePower: null,
                    setDischargePower: null,
                    inverterState: null,
                    lastUpdate: 0
                });
            }
        }

        Logger.info(`MqttBatteryState: mapped ${this.idToMac.size} batteries: ${JSON.stringify(Object.fromEntries(this.idToMac))}`);
    }

    initialize() {
        if (this.idToMac.size === 0) {
            Logger.info("MqttBatteryState: no batteries mapped, skipping MQTT connection");
            return;
        }

        this.client = mqtt.connect(this.brokerUrl);

        this.client.on("error", (err) => {
            Logger.error(`MqttBatteryState MQTT error:`, err.message);
        });

        this.client.on("connect", () => {
            Logger.info(`MqttBatteryState: connected to ${this.brokerUrl}`);
            // Subscribe to all battery state topics
            this.client.subscribe([
                "marstek2mqtt/+/soc",
                "marstek2mqtt/+/battery_power",
                "marstek2mqtt/+/set_charge_power",
                "marstek2mqtt/+/set_discharge_power",
                "marstek2mqtt/+/inverter_state"
            ]);
        });

        this.client.on("message", (topic, payload) => {
            this.handleMessage(topic, payload);
        });
    }

    handleMessage(topic, payload) {
        const parts = topic.split("/");
        if (parts.length < 3) return;

        const id = parts[1].toLowerCase();
        const field = parts[2];
        const value = parseFloat(payload.toString());
        if (isNaN(value)) return;

        // Map MQTT ID → MAC
        const mac = this.idToMac.get(id);
        if (!mac) return;

        const battery = this.batteries.get(mac);
        if (!battery) return;

        switch (field) {
            case "soc":
                battery.soc = value;
                break;
            case "battery_power":
                battery.batteryPower = value;
                break;
            case "set_charge_power":
                battery.setChargePower = value;
                break;
            case "set_discharge_power":
                battery.setDischargePower = value;
                break;
            case "inverter_state":
                battery.inverterState = payload.toString().trim();
                break;
        }

        battery.lastUpdate = Date.now();
    }

    // Returns continuous freshness: 1.0 (fresh) → 0.0 (stale)
    freshness(mac) {
        const battery = this.batteries.get(mac.toLowerCase());
        if (!battery || battery.lastUpdate === 0) return 0;

        const age = (Date.now() - battery.lastUpdate) / 1000;
        if (age < this.freshFull) return 1.0;
        if (age > this.freshDead) return 0.0;
        // Linear decay between freshFull and freshDead
        return 1.0 - (age - this.freshFull) / (this.freshDead - this.freshFull);
    }

    getSoC(mac) {
        const battery = this.batteries.get(mac.toLowerCase());
        return battery ? battery.soc : null;
    }

    getLimits(mac) {
        const battery = this.batteries.get(mac.toLowerCase());
        if (!battery) return null;
        return {
            setChargePower: battery.setChargePower,
            setDischargePower: battery.setDischargePower
        };
    }

    isFresh(mac, thresholdSeconds) {
        const battery = this.batteries.get(mac.toLowerCase());
        if (!battery || battery.lastUpdate === 0) return false;
        return (Date.now() - battery.lastUpdate) / 1000 < thresholdSeconds;
    }

    // Get all known MACs (from BATTERY_MAP)
    getAllMacAddresses() {
        return Array.from(this.batteries.keys());
    }

    // Check if this battery has MQTT data available at all
    hasData(mac) {
        return this.batteries.has(mac.toLowerCase());
    }
}

module.exports = MqttBatteryState;
