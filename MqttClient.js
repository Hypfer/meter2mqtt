const Logger = require("./Logger");
const mqtt = require("mqtt");


class MqttClient {
    /**
     *
     * @param {import("./Poller")} poller
     * @param {import("./MarstekShellyEmu")} [marstekShellyEmu]
     */
    constructor(poller, marstekShellyEmu = null) {
        this.poller = poller;
        this.marstekShellyEmu = marstekShellyEmu;

        this.identifier = process.env.IDENTIFIER || "Main";

        this.autoconfTimestamp = {};

        this.oversamplingFactor = parseInt(process.env.OVERSAMPLING_FACTOR) || 1;
        this.sampleCounter = 0;

        this.poller.onData((data) => {
            this.sampleCounter++;

            if (this.sampleCounter % this.oversamplingFactor === 0) {
                this.sampleCounter = 0;

                this.handleData(data);
            }
        });
    }

    initialize() {
        const options = {
            clientId: `meter2mqtt_${this.identifier}_${Math.random().toString(16).slice(2, 9)}`,  // 23 characters allowed
        };

        if (process.env.MQTT_USERNAME) {
            options.username = process.env.MQTT_USERNAME;

            if (process.env.MQTT_PASSWORD) {
                options.password = process.env.MQTT_PASSWORD;
            }
        } else if (process.env.MQTT_PASSWORD) {
            // MQTT_PASSWORD is set but MQTT_USERNAME is not
            Logger.error("MQTT_PASSWORD is set but MQTT_USERNAME is not. MQTT_USERNAME must be set if MQTT_PASSWORD is set.");
            process.exit(1);
        }

        this.client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

        this.client.on("connect", () => {
            Logger.info("Connected to MQTT broker");

            if (this.marstekShellyEmu) {
                const topic = `${MqttClient.TOPIC_PREFIX}/${this.identifier}/marstek_shelly_emu/set/power`;

                this.client.subscribe(topic, (err) => {
                    if (err) {
                        Logger.error(`Failed to subscribe to ${topic}`, err);
                    } else {
                        Logger.info(`Subscribed to marstek shelly emu override topic: ${topic}`);
                    }
                });
            }
        });

        this.client.on("message", (topic, message) => {
            if (this.marstekShellyEmu && topic === `${MqttClient.TOPIC_PREFIX}/${this.identifier}/marstek_shelly_emu/set/power`) {
                const val = parseFloat(message.toString());

                if (!isNaN(val)) {
                    this.marstekShellyEmu.setOverride(val);
                } else {
                    Logger.warn(`Received invalid value: ${message.toString()}`);
                }
            }
        });

        this.client.on("error", (e) => {
            if (e && e.message === "Not supported") {
                Logger.info("Connected to non-standard-compliant MQTT Broker.");
            } else {
                Logger.error("MQTT error:", e.toString());
            }
        });

        this.client.on("reconnect", () => {
            Logger.info("Attempting to reconnect to MQTT broker");
        });
    }

    handleHandshake(data) {
        // Nothing to see here
    }

    handleData(data) {
        this.ensureAutoconf(this.identifier);

        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${this.identifier}`;

        const stringData = {}

        Object.entries(data).forEach(([key, value]) => {
            stringData[key] = `${value}`;
        })

        this.client.publish(`${baseTopic}/l1/v/n`, stringData.V_L1_N);
        this.client.publish(`${baseTopic}/l2/v/n`, stringData.V_L2_N);
        this.client.publish(`${baseTopic}/l3/v/n`, stringData.V_L3_N);

        this.client.publish(`${baseTopic}/l1/v/l2`, stringData.V_L1_L2);
        this.client.publish(`${baseTopic}/l2/v/l3`, stringData.V_L2_L3);
        this.client.publish(`${baseTopic}/l3/v/l1`, stringData.V_L3_L1);

        this.client.publish(`${baseTopic}/l1/i`, stringData.A_L1);
        this.client.publish(`${baseTopic}/l2/i`, stringData.A_L2);
        this.client.publish(`${baseTopic}/l3/i`, stringData.A_L3);

        this.client.publish(`${baseTopic}/l1/s`, stringData.VA_L1);
        this.client.publish(`${baseTopic}/l2/s`, stringData.VA_L2);
        this.client.publish(`${baseTopic}/l3/s`, stringData.VA_L3);

        this.client.publish(`${baseTopic}/l1/q`, stringData.VAR_L1);
        this.client.publish(`${baseTopic}/l2/q`, stringData.VAR_L2);
        this.client.publish(`${baseTopic}/l3/q`, stringData.VAR_L3);

        this.client.publish(`${baseTopic}/l1/w`, stringData.W_L1);
        this.client.publish(`${baseTopic}/l2/w`, stringData.W_L2);
        this.client.publish(`${baseTopic}/l3/w`, stringData.W_L3);

        this.client.publish(`${baseTopic}/l1/pf`, stringData.PF_L1);
        this.client.publish(`${baseTopic}/l2/pf`, stringData.PF_L2);
        this.client.publish(`${baseTopic}/l3/pf`, stringData.PF_L3);


        this.client.publish(`${baseTopic}/v/n/avg`, stringData.V_L_N_AVG);
        this.client.publish(`${baseTopic}/v/l/avg`, stringData.V_L_L_AVG);

        this.client.publish(`${baseTopic}/pf/sum`, stringData.PF_SUM);

        this.client.publish(`${baseTopic}/w/total`, stringData.W_TOTAL);
        this.client.publish(`${baseTopic}/va/total`, stringData.VA_TOTAL);
        this.client.publish(`${baseTopic}/var/total`, stringData.VAR_TOTAL);

        this.client.publish(`${baseTopic}/kwh/total/in`, stringData.KWH_IN_TOTAL);
        this.client.publish(`${baseTopic}/kvarh/total/in`, stringData.KVARH_IN_TOTAL);

        this.client.publish(`${baseTopic}/kwh/total/out`, stringData.KWH_OUT_TOTAL);
        this.client.publish(`${baseTopic}/kvarh/total/out`, stringData.KVARH_OUT_TOTAL);

        this.client.publish(`${baseTopic}/dmd/w`, stringData.DMD_W);
        this.client.publish(`${baseTopic}/dmd/w/max`, stringData.DMD_W_MAX);

        this.client.publish(`${baseTopic}/hz`, stringData.HZ);
    }

    ensureAutoconf(identifier) {
        // (Re-)publish every 4 hours
        if (Date.now() - (this.autoconfTimestamp ?? 0) <= 4 * 60 * 60 * 1000) {
            return;
        }
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${identifier}`;
        const discoveryTopic = `homeassistant/sensor/meter2mqtt_${identifier}`;
        const device = {
            "manufacturer":"Carlo Gavazzi",
            "model":"EM24",
            "name":`Carlo Gavazzi EM24 ${identifier}`,
            "identifiers":[
                `meter2mqtt_${identifier}`
            ]
        };

        this.client.publish(
            `${discoveryTopic}/l1_v_n/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/v/n`,
                "name": "L1 to N Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_v_n`,
                "unique_id": `meter2mqtt_${identifier}_l1_v_n`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_v_n/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/v/n`,
                "name": "L2 to N Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_v_n`,
                "unique_id": `meter2mqtt_${identifier}_l2_v_n`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_v_n/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/v/n`,
                "name": "L3 to N Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_v_n`,
                "unique_id": `meter2mqtt_${identifier}_l3_v_n`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_v_l2/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/v/l2`,
                "name": "L1 to L2 Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_v_l2`,
                "unique_id": `meter2mqtt_${identifier}_l1_v_l2`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_v_l3/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/v/l3`,
                "name": "L2 to L3 Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_v_l3`,
                "unique_id": `meter2mqtt_${identifier}_l2_v_l3`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_v_l1/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/v/l1`,
                "name": "L3 to L1 Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_v_l1`,
                "unique_id": `meter2mqtt_${identifier}_l3_v_l1`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_i/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/i`,
                "name": "L1 Current",
                "unit_of_measurement": "A",
                "device_class": "current",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_i`,
                "unique_id": `meter2mqtt_${identifier}_l1_i`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_i/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/i`,
                "name": "L2 Current",
                "unit_of_measurement": "A",
                "device_class": "current",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_i`,
                "unique_id": `meter2mqtt_${identifier}_l2_i`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_i/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/i`,
                "name": "L3 Current",
                "unit_of_measurement": "A",
                "device_class": "current",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_i`,
                "unique_id": `meter2mqtt_${identifier}_l3_i`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_s/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/s`,
                "name": "L1 Apparent Power",
                "unit_of_measurement": "VA",
                "device_class": "apparent_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_s`,
                "unique_id": `meter2mqtt_${identifier}_l1_s`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_s/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/s`,
                "name": "L2 Apparent Power",
                "unit_of_measurement": "VA",
                "device_class": "apparent_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_s`,
                "unique_id": `meter2mqtt_${identifier}_l2_s`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_s/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/s`,
                "name": "L3 Apparent Power",
                "unit_of_measurement": "VA",
                "device_class": "apparent_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_s`,
                "unique_id": `meter2mqtt_${identifier}_l3_s`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_q/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/q`,
                "name": "L1 Reactive Power",
                "unit_of_measurement": "var",
                "device_class": "reactive_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_q`,
                "unique_id": `meter2mqtt_${identifier}_l1_q`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_q/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/q`,
                "name": "L2 Reactive Power",
                "unit_of_measurement": "var",
                "device_class": "reactive_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_q`,
                "unique_id": `meter2mqtt_${identifier}_l2_q`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_q/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/q`,
                "name": "L3 Reactive Power",
                "unit_of_measurement": "var",
                "device_class": "reactive_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_q`,
                "unique_id": `meter2mqtt_${identifier}_l3_q`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_w/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/w`,
                "name": "L1 Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_w`,
                "unique_id": `meter2mqtt_${identifier}_l1_w`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_w/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/w`,
                "name": "L2 Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_w`,
                "unique_id": `meter2mqtt_${identifier}_l2_w`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_w/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/w`,
                "name": "L3 Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_w`,
                "unique_id": `meter2mqtt_${identifier}_l3_w`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l1_pf/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l1/pf`,
                "name": "L1 Power Factor",
                "device_class": "power_factor",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l1_pf`,
                "unique_id": `meter2mqtt_${identifier}_l1_pf`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l2_pf/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l2/pf`,
                "name": "L2 Power Factor",
                "device_class": "power_factor",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l2_pf`,
                "unique_id": `meter2mqtt_${identifier}_l2_pf`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/l3_pf/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/l3/pf`,
                "name": "L3 Power Factor",
                "device_class": "power_factor",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_l3_pf`,
                "unique_id": `meter2mqtt_${identifier}_l3_pf`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/v_n_avg/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/v/n/avg`,
                "name": "Average L to N Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_v_n_avg`,
                "unique_id": `meter2mqtt_${identifier}_v_n_avg`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/v_l_avg/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/v/l/avg`,
                "name": "Average L to L Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_v_l_avg`,
                "unique_id": `meter2mqtt_${identifier}_v_l_avg`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/pf_sum/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/pf/sum`,
                "name": "Total Power Factor",
                "device_class": "power_factor",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_pf_sum`,
                "unique_id": `meter2mqtt_${identifier}_pf_sum`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/w_total/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/w/total`,
                "name": "Total Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_w_total`,
                "unique_id": `meter2mqtt_${identifier}_w_total`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/va_total/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/va/total`,
                "name": "Total Apparent Power",
                "unit_of_measurement": "VA",
                "device_class": "apparent_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_va_total`,
                "unique_id": `meter2mqtt_${identifier}_va_total`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/var_total/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/var/total`,
                "name": "Total Reactive Power",
                "unit_of_measurement": "var",
                "device_class": "reactive_power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_var_total`,
                "unique_id": `meter2mqtt_${identifier}_var_total`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/kwh_total_in/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/kwh/total/in`,
                "name": "Total Energy In",
                "unit_of_measurement": "kWh",
                "device_class": "energy",
                "state_class": "total_increasing",
                "object_id": `meter2mqtt_${identifier}_kwh_total_in`,
                "unique_id": `meter2mqtt_${identifier}_kwh_total_in`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/kvarh_total_in/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/kvarh/total/in`,
                "name": "Total Reactive Energy In",
                "unit_of_measurement": "kvarh",
                "device_class": "reactive_energy",
                "state_class": "total_increasing",
                "object_id": `meter2mqtt_${identifier}_kvarh_total_in`,
                "unique_id": `meter2mqtt_${identifier}_kvarh_total_in`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/kwh_total_out/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/kwh/total/out`,
                "name": "Total Energy Out",
                "unit_of_measurement": "kWh",
                "device_class": "energy",
                "state_class": "total_increasing",
                "object_id": `meter2mqtt_${identifier}_kwh_total_out`,
                "unique_id": `meter2mqtt_${identifier}_kwh_total_out`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/kvarh_total_out/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/kvarh/total/out`,
                "name": "Total Reactive Energy Out",
                "unit_of_measurement": "kvarh",
                "device_class": "reactive_energy",
                "state_class": "total_increasing",
                "object_id": `meter2mqtt_${identifier}_kvarh_total_out`,
                "unique_id": `meter2mqtt_${identifier}_kvarh_total_out`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/dmd_w/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/dmd/w`,
                "name": "Demand Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_dmd_w`,
                "unique_id": `meter2mqtt_${identifier}_dmd_w`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/dmd_w_max/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/dmd/w/max`,
                "name": "Maximum Demand Active Power",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_dmd_w_max`,
                "unique_id": `meter2mqtt_${identifier}_dmd_w_max`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `${discoveryTopic}/hz/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/hz`,
                "name": "Frequency",
                "unit_of_measurement": "Hz",
                "device_class": "frequency",
                "state_class": "measurement",
                "object_id": `meter2mqtt_${identifier}_hz`,
                "unique_id": `meter2mqtt_${identifier}_hz`,
                "expire_after": 300,
                "enabled_by_default": true,
                "device": device
            }),
            {retain: true}
        );

        this.autoconfTimestamp = Date.now();
    }
}

MqttClient.TOPIC_PREFIX = "meter2mqtt";

module.exports = MqttClient;
