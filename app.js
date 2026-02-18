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
        if (data && data.W_TOTAL !== undefined) {
            marstekShellyEmu.updateMeterReading(data.W_TOTAL);
        }
    });
}

const mqttClient = new MqttClient(poller, marstekShellyEmu);

poller.initialize().then(() => {
    mqttClient.initialize();
}).catch(err => {
    Logger.error("Error while initializing poller", err);
    process.exit(1);
});

