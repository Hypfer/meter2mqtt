const dgram = require("dgram");
const Logger = require("./Logger");

class MarstekShellyEmu {
    constructor() {
        this.server = dgram.createSocket('udp4');
        this.meterPower = { total: 0, l1: 0, l2: 0, l3: 0 };
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
                let currentPower = this.getCurrentPower();

                if (!currentPower) {
                    currentPower = { total: 0, l1: 0, l2: 0, l3: 0 };
                }

                const l1 = currentPower.l1 ?? 0
                const l2 = currentPower.l2 ?? 0;
                const l3 = currentPower.l3 ?? 0;
                const total = currentPower.total ?? 0;

                Logger.debug(`Marstek request from ${rinfo.address}:${rinfo.port}, replying with L1:${l1}W L2:${l2}W L3:${l3}W Total:${total}W`);

                // This is not how the shelly protocol actually looks like, but it is enough for the parser in the marstek firmware
                // As a bonus, it should be incomprehensible to anything other than the marstek battery
                const payload = `a_act_power==${l1},b_act_power==${l2},c_act_power==${l3},total_act_power==${total}`;

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

    updateMeterReading(powerData) {
        this.meterPower = powerData;
    }

    setOverride(powerData) {
        Logger.debug(`Received override value: ${JSON.stringify(powerData)}`);

        this.overridePower = powerData;

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
