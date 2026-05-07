const Logger = require("./Logger");
const Poller = require("./Poller");
const MqttClient = require("./MqttClient");
const MarstekShellyEmu = require("./MarstekShellyEmu");
const MarstekCtEmu = require("./MarstekCt002Emu");
const MqttBatteryState = require("./MqttBatteryState");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const poller = new Poller();
let marstekShellyEmu = null;
let marstekCtEmu = null;

const ctType = (process.env.CT_TYPE || "").toLowerCase();
if (ctType === "shelly") {
    Logger.info("Initializing MarstekShellyEmu");
    marstekShellyEmu = new MarstekShellyEmu();
    marstekShellyEmu.initialize();
} else if (ctType === "hme-3" || ctType === "hme-4") {
    Logger.info(`Initializing MarstekCtEmu (${process.env.CT_TYPE})`);
    marstekCtEmu = new MarstekCtEmu();
    marstekCtEmu.initialize();
}

// Initialize MQTT battery state tracking
const mqttBatteryState = new MqttBatteryState();
mqttBatteryState.initialize();

// Wire MQTT battery state into CT emulator steering algorithm
if (marstekCtEmu) {
    marstekCtEmu.steering.mqtt = mqttBatteryState;
}

poller.onData((data) => {
    const powerData = {
        total: data.W_TOTAL,
        l1: data.W_L1,
        l2: data.W_L2,
        l3: data.W_L3
    };

    if (marstekShellyEmu) marstekShellyEmu.updateMeterReading(powerData);
    if (marstekCtEmu) marstekCtEmu.updateMeterReading(powerData);
});

const mqttClient = new MqttClient(poller, marstekShellyEmu);

poller.initialize().then(() => {
    mqttClient.initialize();
}).catch(err => {
    Logger.error("Error while initializing poller", err);
    process.exit(1);
});
