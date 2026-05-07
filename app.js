const Logger = require("./Logger");
const Poller = require("./Poller");
const MqttClient = require("./MqttClient");
const MarstekShellyEmu = require("./MarstekShellyEmu");

if (process.env.LOGLEVEL) {
    Logger.setLogLevel(process.env.LOGLEVEL);
}

const poller = new Poller();
let marstekShellyEmu = null;

if (process.env.MARSTEK_SHELLY_EMU) {
    Logger.info("Initializing MarstekShellyEmu");

    marstekShellyEmu = new MarstekShellyEmu();
    marstekShellyEmu.initialize();

    poller.onData((data) => {
        marstekShellyEmu.updateMeterReading({
            total: data.W_TOTAL,
            l1: data.W_L1,
            l2: data.W_L2,
            l3: data.W_L3
        });
    });
}

const mqttClient = new MqttClient(poller, marstekShellyEmu);

poller.initialize().then(() => {
    mqttClient.initialize();
}).catch(err => {
    Logger.error("Error while initializing poller", err);
    process.exit(1);
});

