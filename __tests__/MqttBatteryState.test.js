const MqttBatteryState = require("../MqttBatteryState");

describe("MqttBatteryState", () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        // Clear env
        delete process.env.BATTERY_MAP;
        delete process.env.MQTT_BROKER_URL;
        delete process.env.MQTT_FRESH_FULL;
        delete process.env.MQTT_FRESH_DEAD;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("parseBatteryMap", () => {
        test("parses single battery", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            expect(state.idToMac.get("one")).toBe("aabbccddeeff");
            expect(state.batteries.has("aabbccddeeff")).toBe(true);
        });

        test("parses multiple batteries", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff,Two:112233445566";
            const state = new MqttBatteryState();
            expect(state.idToMac.get("one")).toBe("aabbccddeeff");
            expect(state.idToMac.get("two")).toBe("112233445566");
        });

        test("handles missing BATTERY_MAP", () => {
            const state = new MqttBatteryState();
            expect(state.idToMac.size).toBe(0);
        });

        test("normalizes to lowercase", () => {
            process.env.BATTERY_MAP = "One:AABBCCDDEEFF";
            const state = new MqttBatteryState();
            expect(state.idToMac.get("one")).toBe("aabbccddeeff");
        });
    });

    describe("freshness", () => {
        test("returns 0 for unknown MAC", () => {
            const state = new MqttBatteryState();
            expect(state.freshness("unknown")).toBe(0);
        });

        test("returns 0 when never updated", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            expect(state.freshness("aabbccddeeff")).toBe(0);
        });

        test("returns 1.0 when fresh (< 60s)", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            const batt = state.batteries.get("aabbccddeeff");
            batt.lastUpdate = Date.now() - 30000; // 30s ago
            expect(state.freshness("aabbccddeeff")).toBe(1.0);
        });

        test("returns 0.0 when stale (> 90s)", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            const batt = state.batteries.get("aabbccddeeff");
            batt.lastUpdate = Date.now() - 100000; // 100s ago
            expect(state.freshness("aabbccddeeff")).toBe(0.0);
        });

        test("decays linearly between 60-90s", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            process.env.MQTT_FRESH_FULL = "60";
            process.env.MQTT_FRESH_DEAD = "90";
            const state = new MqttBatteryState();
            const batt = state.batteries.get("aabbccddeeff");
            batt.lastUpdate = Date.now() - 75000; // 75s ago (midpoint)
            expect(state.freshness("aabbccddeeff")).toBeCloseTo(0.5);
        });
    });

    describe("handleMessage", () => {
        test("updates SoC from MQTT message", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            state.handleMessage("marstek2mqtt/One/soc", Buffer.from("75.3"));
            expect(state.getSoC("aabbccddeeff")).toBe(75.3);
        });

        test("updates charge limit", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            state.handleMessage("marstek2mqtt/One/set_charge_power", Buffer.from("500"));
            const limits = state.getLimits("aabbccddeeff");
            expect(limits.setChargePower).toBe(500);
        });

        test("ignores unknown ID", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            state.handleMessage("marstek2mqtt/Unknown/soc", Buffer.from("50"));
            expect(state.getSoC("aabbccddeeff")).toBeNull();
        });

        test("rejects NaN payload", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            state.handleMessage("marstek2mqtt/One/soc", Buffer.from("abc"));
            expect(state.getSoC("aabbccddeeff")).toBeNull();
        });

        test("rejects empty payload", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            state.handleMessage("marstek2mqtt/One/soc", Buffer.from(""));
            expect(state.getSoC("aabbccddeeff")).toBeNull();
        });

        test("updates timestamp on message", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            const before = Date.now();
            state.handleMessage("marstek2mqtt/One/soc", Buffer.from("50"));
            const after = Date.now();
            const batt = state.batteries.get("aabbccddeeff");
            expect(batt.lastUpdate).toBeGreaterThanOrEqual(before);
            expect(batt.lastUpdate).toBeLessThanOrEqual(after);
        });
    });

    describe("getSoC / getLimits", () => {
        test("returns null for unknown MAC", () => {
            const state = new MqttBatteryState();
            expect(state.getSoC("unknown")).toBeNull();
            expect(state.getLimits("unknown")).toBeNull();
        });

        test("returns null SoC when never updated", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff";
            const state = new MqttBatteryState();
            expect(state.getSoC("aabbccddeeff")).toBeNull();
        });
    });

    describe("getAllMacAddresses", () => {
        test("returns all mapped MACs", () => {
            process.env.BATTERY_MAP = "One:aabbccddeeff,Two:112233445566";
            const state = new MqttBatteryState();
            const macs = state.getAllMacAddresses();
            expect(macs).toContain("aabbccddeeff");
            expect(macs).toContain("112233445566");
            expect(macs.length).toBe(2);
        });
    });
});
