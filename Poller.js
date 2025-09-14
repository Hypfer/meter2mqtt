const EventEmitter = require("events").EventEmitter;
const ModbusRTU = require("modbus-serial");
const Logger = require("./Logger");

function parseValue(buffer, start, length, factor, fixed) {
    return parseFloat((Buffer.from(buffer.slice(start, start + length)).swap16().readInt32LE() * factor).toFixed(fixed));
}

function parseShortValue(buffer, start, factor, fixed) {
    return parseFloat((buffer.readInt16BE(start) * factor).toFixed(fixed));
}

class Poller {
    constructor() {
        this.eventEmitter = new EventEmitter();
        this.client = new ModbusRTU();
    }

    async initialize() {
        if (!process.env.POLL_IP) {
            Logger.error("POLL_IP is not set.");

            process.exit(1);
        }

        const interval = Number(process.env.POLL_INTERVAL) || 5_000;

        await this.client.connectTCP(process.env.POLL_IP, { port: 502 });
        this.client.setID(1);
        
        const pollingLoop = async () => {
            try {
                await this.poll();
            } catch (err) {
                Logger.warn("Error during poll", err);
            }

            setTimeout(() => {
                pollingLoop().catch(() => {/* intentional */});
            }, interval - (Date.now() % interval));
        };
        
        pollingLoop().catch(() => {/* intentional */});
    }

    async poll() {
        let data;
        try {
            data = await this.client.readHoldingRegisters(0, 82);
        } catch(err) {
            Logger.warn("Error while polling", err)
        }

        if (!data) {
            return;
        }

        const output = {
            V_L1_N: parseValue(data.buffer, 0, 4, 0.1, 5),
            V_L2_N: parseValue(data.buffer, 4, 4, 0.1, 5),
            V_L3_N: parseValue(data.buffer, 8, 4, 0.1, 5),

            V_L1_L2: parseValue(data.buffer, 12, 4, 0.1, 5),
            V_L2_L3: parseValue(data.buffer, 16, 4, 0.1, 5),
            V_L3_L1: parseValue(data.buffer, 20, 4, 0.1, 5),

            A_L1: parseValue(data.buffer, 24, 4, 0.001, 5),
            A_L2: parseValue(data.buffer, 28, 4, 0.001, 5),
            A_L3: parseValue(data.buffer, 32, 4, 0.001, 5),

            W_L1: parseValue(data.buffer, 36, 4, 0.1, 5),
            W_L2: parseValue(data.buffer, 40, 4, 0.1, 5),
            W_L3: parseValue(data.buffer, 44, 4, 0.1, 5),

            VA_L1: parseValue(data.buffer, 48, 4, 0.1, 5),
            VA_L2: parseValue(data.buffer, 52, 4, 0.1, 5),
            VA_L3: parseValue(data.buffer, 56, 4, 0.1, 5),

            VAR_L1: parseValue(data.buffer, 60, 4, 0.1, 5),
            VAR_L2: parseValue(data.buffer, 64, 4, 0.1, 5),
            VAR_L3: parseValue(data.buffer, 68, 4, 0.1, 5),

            V_L_N_AVG: parseValue(data.buffer, 72, 4, 0.1, 5),
            V_L_L_AVG: parseValue(data.buffer, 76, 4, 0.1, 5),

            W_TOTAL: parseValue(data.buffer, 80, 4, 0.1, 5),
            VA_TOTAL: parseValue(data.buffer, 84, 4, 0.1, 5),
            VAR_TOTAL: parseValue(data.buffer, 88, 4, 0.1, 5),

            PF_L1: parseShortValue(data.buffer, 92, 0.001, 5), // Negative is lead, positive is lag
            PF_L2: parseShortValue(data.buffer, 94, 0.001, 5),
            PF_L3: parseShortValue(data.buffer, 96, 0.001, 5),
            PF_SUM: parseShortValue(data.buffer, 98, 0.001, 5),

            // Phase sequence

            HZ: parseShortValue(data.buffer, 102, 0.1, 5),

            KWH_IN_TOTAL: parseValue(data.buffer, 104, 4, 0.1, 5),
            KVARH_IN_TOTAL: parseValue(data.buffer, 108, 4, 0.1, 5),

            DMD_W: parseValue(data.buffer, 112, 4, 0.1, 5),
            DMD_W_MAX: parseValue(data.buffer, 116, 4, 0.1, 5),
            
            KWH_OUT_TOTAL: parseValue(data.buffer, 156, 4, 0.1, 5),
            KVARH_OUT_TOTAL: parseValue(data.buffer, 160, 4, 0.1, 5),
        };

        this.emitData(output);
    }

    emitData(data) {
        this.eventEmitter.emit(Poller.EVENTS.Data, data);
    }

    onData(listener) {
        this.eventEmitter.on(Poller.EVENTS.Data, listener);
    }
}

Poller.EVENTS = {
    Data: "Data"
}

module.exports = Poller;
