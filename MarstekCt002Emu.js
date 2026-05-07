const dgram = require("dgram");
const Logger = require("./Logger");
const SteeringAlgorithm = require("./SteeringAlgorithm");

class MarstekCt002Emu {
    constructor() {
        this.server = dgram.createSocket("udp4");
        this.meterPower = { total: 0, l1: 0, l2: 0, l3: 0 };

        // State
        this.consumers = new Map();
        this.infoIdxCounter = 0;

        // Configuration
        this.port = parseInt(process.env.CT_PORT) || 12345;
        this.ctType = process.env.CT_TYPE || "HME-4";
        this.ctMac = process.env.CT_MAC || "";
        this.wifiRssi = parseInt(process.env.CT_RSSI) || -50;
        this.activeControl = process.env.CT_ACTIVE_CONTROL !== "false";
        this.consumerTtl = parseInt(process.env.CT_CONSUMER_TTL) || 30;

        // Steering algorithm
        this.steering = new SteeringAlgorithm({
            mqtt: null, // set by app.js after wiring
            deadbandEnter: parseInt(process.env.CT_DEADBAND_ENTER) || 25,
            deadbandExit: parseInt(process.env.CT_DEADBAND_EXIT) || 15,
            alpha: parseFloat(process.env.CT_ALPHA) || 0.08,
            alphaSignFlip: parseFloat(process.env.CT_ALPHA_SIGN_FLIP) || 0.32,
            maxDev: parseFloat(process.env.CT_MAX_DEV) || 30,
            correctionK: parseFloat(process.env.CT_CORRECTION_K) || 0.5,
            minEfficientPower: parseInt(process.env.CT_MIN_EFFICIENT_POWER) || 150,
            rotationInterval: parseInt(process.env.CT_ROTATION_INTERVAL) || 300,
            saturationAlpha: parseFloat(process.env.CT_SATURATION_ALPHA) || 0.15
        });
    }

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    initialize() {
        this.server.on("error", (err) => {
            Logger.error(`MarstekCt002Emu server error:\n${err.stack}`);
            this.server.close();
        });

        this.server.on("message", (msg, rinfo) => this.handleMessage(msg, rinfo));

        this.server.on("listening", () => {
            const address = this.server.address();
            Logger.info(`MarstekCt002Emu listening on UDP ${address.address}:${address.port} (Type: ${this.ctType})`);
        });

        try {
            this.server.bind(this.port);
            this.startCleanupTimer();
        } catch (e) {
            Logger.error(`Failed to bind MarstekCt002Emu to port ${this.port}`, e);
        }
    }

    startCleanupTimer() {
        setInterval(() => {
            const now = Date.now();
            for (const [id, c] of this.consumers.entries()) {
                if (now - c.timestamp > this.consumerTtl * 1000) {
                    this.consumers.delete(id);
                }
            }
            this.steering.removeOffline(Array.from(this.consumers.keys()));
        }, 5000);
    }

    updateMeterReading(powerData) {
        this.meterPower = powerData;
    }

    // ---------------------------------------------------------------------------
    // Request Handling
    // ---------------------------------------------------------------------------

    handleMessage(msg, rinfo) {
        const fields = this.parseRequest(msg);
        if (!fields || fields.length < 4) return;

        // MAC validation
        const reqCtMac = fields[3];
        if (this.ctMac && reqCtMac.toLowerCase() !== this.ctMac.toLowerCase()) return;

        const consumerId = fields[1] ? fields[1].toLowerCase() : `${rinfo.address}:${rinfo.port}`;
        const reportedPhase = (fields.length > 4 ? fields[4] : "").trim().toUpperCase();
        const reportedPower = fields.length > 5 ? parseInt(fields[5], 10) || 0 : 0;

        const isInspectionMode = !["A", "B", "C"].includes(reportedPhase);
        if (isInspectionMode && !["0", ""].includes(reportedPhase)) return;

        // 1. Update consumer state
        this.trackConsumer(consumerId, reportedPhase, reportedPower, isInspectionMode, rinfo);

        // 2. Calculate targets
        const currentPowerArr = [
            this.meterPower.l1 || 0,
            this.meterPower.l2 || 0,
            this.meterPower.l3 || 0
        ];
        let targetArr = currentPowerArr;

        if (this.activeControl && !isInspectionMode) {
            targetArr = this._computeTargetArr(currentPowerArr, consumerId);
        }

        // 3. Send Response
        try {
            const responseFields = this.buildResponseFields(fields, targetArr);
            const responseBuf = this.buildPayload(responseFields);
            this.server.send(responseBuf, rinfo.port, rinfo.address);
        } catch (err) {
            Logger.warn(`Failed to build CT002 response:`, err.message);
        }
    }

    trackConsumer(id, phase, power, isInspection, rinfo) {
        if (isInspection) return;

        let consumer = this.consumers.get(id);
        if (!consumer) {
            consumer = { phase: "A", power: 0, timestamp: Date.now(), lastTarget: null, saturation: 0.0 };
            this.consumers.set(id, consumer);
            this.steering.updatePriorityOrder([id]);
            Logger.info(`CT002: new battery MAC=${id} phase=${phase} from ${rinfo.address}:${rinfo.port} — add to BATTERY_MAP for SoC steering`);
        }
        consumer.phase = phase;
        consumer.power = power;
        consumer.timestamp = Date.now();
    }

    _computeTargetArr(values, consumerId) {
        const gridTotal = values.reduce((a, b) => a + b, 0);

        // Trigger efficiency rotation check
        this.steering.maybeRotate();

        // Compute scalar target from steering algorithm
        const target = this.steering.computeTarget(gridTotal, consumerId, this.consumers);

        // Map to phase array: only set the battery's own phase field
        const consumer = this.consumers.get(consumerId);
        const phaseIdx = consumer ? { A: 0, B: 1, C: 2 }[consumer.phase] : 0;
        return [0, 0, 0].map((v, i) => i === phaseIdx ? Math.round(target) : 0);
    }

    // ---------------------------------------------------------------------------
    // Protocol Builders
    // ---------------------------------------------------------------------------

    buildResponseFields(requestFields, values) {
        const measuredTotal = values[0] + values[1] + values[2];
        const meterDevType = requestFields[0] || "HMG-50";
        const meterMac = requestFields[1] || "";
        const ctMac = this.ctMac || requestFields[3] || "";

        const resp = new Array(24).fill("0");
        resp[0] = this.ctType;
        resp[1] = ctMac;
        resp[2] = meterDevType;
        resp[3] = meterMac;
        resp[4] = String(Math.round(values[0]));
        resp[5] = String(Math.round(values[1]));
        resp[6] = String(Math.round(values[2]));
        resp[7] = String(Math.round(measuredTotal));
        resp[12] = String(this.wifiRssi);
        resp[13] = String(this.infoIdxCounter);

        // Aggregate actual battery power per phase
        const byPhase = { A: { chrg: 0, dchrg: 0 }, B: { chrg: 0, dchrg: 0 }, C: { chrg: 0, dchrg: 0 } };
        for (const c of this.consumers.values()) {
            const p = c.phase || "A";
            if (c.power < 0) byPhase[p].chrg += c.power;
            else if (c.power > 0) byPhase[p].dchrg += c.power;
        }

        ["A", "B", "C"].forEach((p, i) => {
            const hasActivity = byPhase[p].chrg !== 0 || byPhase[p].dchrg !== 0;
            resp[8 + i] = hasActivity ? "1" : "0";
            resp[15 + i] = String(byPhase[p].chrg);
            resp[20 + i] = String(byPhase[p].dchrg);
        });

        this.infoIdxCounter = (this.infoIdxCounter + 1) % 256;
        return resp;
    }

    parseRequest(msg) {
        if (msg.length < 10 || msg[0] !== 0x01 || msg[1] !== 0x02) return null;
        const sepIdx = msg.indexOf(0x7c, 2);
        if (sepIdx === -1) return null;

        const expectedLen = parseInt(msg.toString('ascii', 2, sepIdx), 10);
        if (msg.length !== expectedLen || msg[expectedLen - 3] !== 0x03) return null;

        let xor = 0;
        for (let i = 0; i < expectedLen - 2; i++) xor ^= msg[i];

        const expectedChk = xor.toString(16).padStart(2, '0').toLowerCase();
        const actualChk = msg.toString('ascii', expectedLen - 2).toLowerCase();

        if (actualChk !== expectedChk && !(actualChk[0] === ' ' && actualChk[1] === expectedChk[1])) return null;

        return msg.toString('ascii', sepIdx, expectedLen - 3).split('|').slice(1);
    }

    buildPayload(fields) {
        const msgStr = "|" + fields.join("|");
        const baseLen = 4 + msgStr.length + 2; // SOH+STX+ETX+Checksum

        let totalLen = 0;
        for (let i = 1; i <= 4; i++) {
            if (String(baseLen + i).length === i) {
                totalLen = baseLen + i;
                break;
            }
        }

        const header = String.fromCharCode(0x01, 0x02) + totalLen;
        const footer = String.fromCharCode(0x03);
        const buf = Buffer.from(header + msgStr + footer, "ascii");

        let xor = 0;
        for (let i = 0; i < buf.length; i++) xor ^= buf[i];

        return Buffer.concat([buf, Buffer.from(xor.toString(16).padStart(2, '0'), "ascii")]);
    }
}

module.exports = MarstekCt002Emu;
