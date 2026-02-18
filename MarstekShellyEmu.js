const dgram = require("dgram");
const Logger = require("./Logger");

class MarstekShellyEmu {
    constructor() {
        this.server = dgram.createSocket('udp4');
        this.meterPower = null;
        this.overridePower = null;
        this.overrideExpiryTimeout = null;
    }

    initialize() {
        const port = 1010;

        this.server.on('error', (err) => {
            Logger.error(`MarstekShellyEmu server error:\n${err.stack}`);

            this.server.close();
        });

        this.server.on('message', (msg, rinfo) => {
            const message = msg.toString();
            
            if (message.includes('EM.GetStatus')) {
                let currentWatts = this.getCurrentPower();
                
                if (currentWatts === null || currentWatts === undefined) {
                    currentWatts = 0;
                }
                
                currentWatts = currentWatts.toFixed(0);

                Logger.debug(`Marstek request from ${rinfo.address}:${rinfo.port}, replying with ${currentWatts}W`);

                // This is not how the shelly protocol actually looks like, but it is enough for the parser in the marstek firmware
                // As a bonus, it should be incomprehensible to anything other than the marstek battery
                //
                // Additionally, since the storage is single phase anyway and the firmware does not understand floats,
                // we just pretend that all power is happening on L1
                const payload = `a_act_power==${currentWatts},b_act_power==0,c_act_power==0,total_act_power==${currentWatts}`;

                this.server.send(payload, rinfo.port, rinfo.address, (err) => {
                    if (err) {
                        Logger.warn('MarstekShellyEmu TX Error:', err);
                    }
                });
            }
        });

        this.server.on('listening', () => {
            const address = this.server.address();

            Logger.info(`MarstekShellyEmu listening on UDP ${address.address}:${address.port}`);
        });

        try {
            this.server.bind(port);
        } catch (e) {
            Logger.error("Failed to bind MarstekShellyEmu to port 1010", e);
        }
    }
    
    updateMeterReading(watts) {
        this.meterPower = watts;
    }

    setOverride(watts) {
        Logger.debug(`Received override value of ${watts}w`);

        this.overridePower = watts;

        if (this.overrideExpiryTimeout) {
            clearTimeout(this.overrideExpiryTimeout);
        }

        this.overrideExpiryTimeout = setTimeout(() => {
            Logger.debug(`Override expired.`);
            
            this.overridePower = null;

            this.overrideExpiryTimeout = null;
        }, 30_000);
    }

    getCurrentPower() {
        if (this.overridePower !== null) {
            return this.overridePower;
        }

        return this.meterPower;
    }
}

module.exports = MarstekShellyEmu;
