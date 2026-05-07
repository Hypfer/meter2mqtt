const SteeringAlgorithm = require("../SteeringAlgorithm");

describe("SteeringAlgorithm", () => {
    function makeConfig(overrides) {
        return {
            mqtt: null,
            deadbandEnter: 25,
            deadbandExit: 15,
            alpha: 0.08,
            alphaSignFlip: 0.32,
            maxDev: 30,
            correctionK: 0.5,
            minEfficientPower: 150,
            rotationInterval: 300,
            saturationAlpha: 0.15,
            ...overrides
        };
    }

    function makeConsumers(batteries) {
        const map = new Map();
        for (const b of batteries) {
            map.set(b.id, {
                id: b.id,
                phase: b.phase || "A",
                power: b.power || 0,
                saturation: b.saturation || 0,
                lastTarget: b.lastTarget !== undefined ? b.lastTarget : null,
                timestamp: Date.now()
            });
        }
        return map;
    }

    function makeMockMqtt(batteryData) {
        const batteries = new Map();
        for (const [mac, data] of Object.entries(batteryData)) {
            batteries.set(mac.toLowerCase(), {
                soc: data.soc,
                batteryPower: data.power || 0,
                setChargePower: data.chargeLimit || null,
                setDischargePower: data.dischargeLimit || null,
                lastUpdate: data.age ? Date.now() - data.age * 1000 : Date.now()
            });
        }

        return {
            idToMac: new Map(Object.entries(batteryData).map(([mac]) => [mac.toLowerCase(), mac.toLowerCase()])),
            batteries,
            freshness(mac) {
                if (!mac) return 0;
                const b = batteries.get(mac.toLowerCase());
                if (!b || b.lastUpdate === 0) return 0;
                const age = (Date.now() - b.lastUpdate) / 1000;
                if (age < 60) return 1.0;
                if (age > 90) return 0.0;
                return 1.0 - (age - 60) / 30;
            },
            getSoC(mac) {
                if (!mac) return null;
                const b = batteries.get(mac.toLowerCase());
                return b ? b.soc : null;
            },
            getLimits(mac) {
                if (!mac) return null;
                const b = batteries.get(mac.toLowerCase());
                if (!b) return null;
                return { setChargePower: b.setChargePower, setDischargePower: b.setDischargePower };
            }
        };
    }

    describe("Step 1: Deadband hysteresis", () => {
        test("enters active control at DEADBAND_ENTER", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            const target = algo.computeTarget(24, "a", consumers);
            expect(algo.inActive).toBe(false);
            expect(target).toBe(0);

            const target2 = algo.computeTarget(26, "a", consumers);
            expect(algo.inActive).toBe(true);
        });

        test("stays active in hysteresis gap after entering", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(100, "a", consumers);
            expect(algo.inActive).toBe(true);

            algo.computeTarget(20, "a", consumers);
            expect(algo.inActive).toBe(true);

            algo.computeTarget(14, "a", consumers);
            expect(algo.inActive).toBe(false);
        });

        test("stays idle below DEADBAND_ENTER", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(20, "a", consumers);
            expect(algo.inActive).toBe(false);
        });
    });

    describe("Step 2: EMA smoothing", () => {
        test("cold start sets smoothed to first sample", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(500, "a", consumers);
            expect(algo.smoothed).toBe(500);
        });

        test("smooths gradually with small alpha", () => {
            const algo = new SteeringAlgorithm(makeConfig({ alpha: 0.1 }));
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(1000, "a", consumers);
            expect(algo.smoothed).toBe(1000);

            algo.computeTarget(0, "a", consumers);
            expect(algo.smoothed).toBeCloseTo(900, 1);
        });

        test("faster alpha on sign flip", () => {
            const algo = new SteeringAlgorithm(makeConfig({ alpha: 0.1, alphaSignFlip: 0.5 }));
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(1000, "a", consumers);
            expect(algo.smoothed).toBe(1000);

            algo.computeTarget(-1000, "a", consumers);
            expect(algo.smoothed).toBeCloseTo(0, 0);
        });
    });

    describe("Step 3: Efficiency mode", () => {
        test("all batteries active when per-battery >= MIN_EFFICIENT_POWER", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(600, "a", consumers);
            expect(algo.smoothed).toBe(600);
            const target = algo.computeTarget(600, "b", consumers);
            expect(target).toBeGreaterThan(0);
        });

        test("reduces active slots when per-battery < MIN_EFFICIENT_POWER", () => {
            const algo = new SteeringAlgorithm(makeConfig({ minEfficientPower: 150 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
            algo.priorityOrder = ["a", "b", "c", "d"];

            algo.computeTarget(400, "a", consumers);
            const targetA = algo.computeTarget(400, "a", consumers);
            const targetB = algo.computeTarget(400, "b", consumers);
            const targetC = algo.computeTarget(400, "c", consumers);
            const targetD = algo.computeTarget(400, "d", consumers);

            const active = [targetA, targetB, targetC, targetD].filter(t => t !== 0).length;
            expect(active).toBe(2);
            expect(targetA + targetB + targetC + targetD).toBeCloseTo(400, 0);
        });

        test("single battery takes all when total < MIN_EFFICIENT_POWER", () => {
            const algo = new SteeringAlgorithm(makeConfig({ minEfficientPower: 150 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            const targetA = algo.computeTarget(80, "a", consumers);
            const targetB = algo.computeTarget(80, "b", consumers);

            expect(targetA).toBeCloseTo(80, 0);
            expect(targetB).toBe(0);
        });
    });

    describe("Step 4-5: SoC correction", () => {
        test("no MQTT: uniform fair share", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(600, "a", consumers);
            const targetA = algo.computeTarget(600, "a", consumers);
            const targetB = algo.computeTarget(600, "b", consumers);
            expect(targetA).toBeCloseTo(targetB, 0);
        });

        test("identical SoC: no correction", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 50 },
                b: { soc: 50 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(600, "a", consumers);
            const targetA = algo.computeTarget(600, "a", consumers);
            const targetB = algo.computeTarget(600, "b", consumers);
            expect(targetA).toBeCloseTo(targetB, 0);
        });

        test("below-avg battery charges more during surplus", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 30 },
                b: { soc: 70 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, correctionK: 0.5, maxDev: 30 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(-600, "a", consumers);
            const targetA = algo.computeTarget(-600, "a", consumers);
            const targetB = algo.computeTarget(-600, "b", consumers);

            expect(targetA).toBeLessThan(targetB);
            expect(targetA).toBeLessThan(-300);
            expect(targetB).toBeGreaterThan(-300);
        });

        test("above-avg battery discharges more during deficit", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 30 },
                b: { soc: 70 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, correctionK: 0.5, maxDev: 30 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(600, "a", consumers);
            const targetA = algo.computeTarget(600, "a", consumers);
            const targetB = algo.computeTarget(600, "b", consumers);

            expect(targetB).toBeGreaterThan(targetA);
        });
    });

    describe("Step 6: Direction clamp (no circular flow)", () => {
        test("no battery flips sign during surplus", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 20 },
                b: { soc: 95 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, correctionK: 1.0 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(-600, "a", consumers);
            const targetA = algo.computeTarget(-600, "a", consumers);
            const targetB = algo.computeTarget(-600, "b", consumers);

            expect(targetA).toBeLessThanOrEqual(0);
            expect(targetB).toBeLessThanOrEqual(0);
        });

        test("no battery flips sign during deficit", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 5 },
                b: { soc: 80 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, correctionK: 1.0 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(600, "a", consumers);
            const targetA = algo.computeTarget(600, "a", consumers);
            const targetB = algo.computeTarget(600, "b", consumers);

            expect(targetA).toBeGreaterThanOrEqual(0);
            expect(targetB).toBeGreaterThanOrEqual(0);
        });
    });

    describe("Step 7: Saturation clamping", () => {
        test("behavioral saturation > 0.9: idle even with fresh MQTT", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 50 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt }));
            const consumers = makeConsumers([{ id: "a", saturation: 0.95, lastTarget: -200, power: 0 }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(-500, "a", consumers);
            const target = algo.computeTarget(-500, "a", consumers);
            expect(target).toBe(0);
        });

        test("charge power limit respected", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 50, chargeLimit: 300 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt }));
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(-800, "a", consumers);
            const target = algo.computeTarget(-800, "a", consumers);
            expect(target).toBeGreaterThanOrEqual(-300);
        });

        test("discharge power limit respected", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 50, dischargeLimit: 250 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt }));
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(800, "a", consumers);
            const target = algo.computeTarget(800, "a", consumers);
            expect(target).toBeLessThanOrEqual(250);
        });

        test("negative power limit ignored (safety)", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 50, chargeLimit: -100 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt }));
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(-800, "a", consumers);
            const target = algo.computeTarget(-800, "a", consumers);
            expect(target).toBeLessThan(-300);
        });
    });

    describe("Step 5e: Correction cap", () => {
        test("correction cannot push active battery below MIN_EFFICIENT_POWER", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 20 },
                b: { soc: 80 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, minEfficientPower: 150, correctionK: 1.0 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo.priorityOrder = ["a", "b"];

            algo.computeTarget(-400, "a", consumers);
            const targetA = algo.computeTarget(-400, "a", consumers);
            const targetB = algo.computeTarget(-400, "b", consumers);

            if (targetA !== 0) expect(Math.abs(targetA)).toBeGreaterThanOrEqual(150);
            if (targetB !== 0) expect(Math.abs(targetB)).toBeGreaterThanOrEqual(150);
        });
    });

    describe("Single battery fleet", () => {
        test("single battery gets full grid total", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            const consumers = makeConsumers([{ id: "a" }]);
            algo.priorityOrder = ["a"];

            algo.computeTarget(500, "a", consumers);
            const target = algo.computeTarget(500, "a", consumers);
            expect(target).toBeCloseTo(500, 0);
        });
    });

    describe("Efficiency rotation", () => {
        test("rotation moves first to end", () => {
            const algo = new SteeringAlgorithm(makeConfig({ rotationInterval: 0 }));
            algo.priorityOrder = ["a", "b", "c"];
            algo.lastRotation = Date.now() - 1000;

            algo.maybeRotate();
            expect(algo.priorityOrder).toEqual(["b", "c", "a"]);
        });

        test("no rotation within interval", () => {
            const algo = new SteeringAlgorithm(makeConfig({ rotationInterval: 300 }));
            algo.priorityOrder = ["a", "b", "c"];
            algo.lastRotation = Date.now();

            algo.maybeRotate();
            expect(algo.priorityOrder).toEqual(["a", "b", "c"]);
        });
    });

    describe("SoC-aware efficiency selection", () => {
        test("prefers below-avg battery during surplus", () => {
            const mqtt = makeMockMqtt({
                a: { soc: 30 },
                b: { soc: 70 },
                c: { soc: 65 },
                d: { soc: 72 }
            });
            const algo = new SteeringAlgorithm(makeConfig({ mqtt, minEfficientPower: 150 }));
            const consumers = makeConsumers([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
            algo.priorityOrder = ["a", "b", "c", "d"];

            const targetA = algo.computeTarget(-400, "a", consumers);
            const targetB = algo.computeTarget(-400, "b", consumers);

            expect(Math.abs(targetA)).toBeGreaterThan(Math.abs(targetB));
        });
    });

    describe("MQTT freshness boundary", () => {
        test("gradual decay prevents target jump at 60s boundary", () => {
            const mqtt60 = makeMockMqtt({ a: { soc: 30, age: 59 }, b: { soc: 70, age: 0 } });
            const mqtt61 = makeMockMqtt({ a: { soc: 30, age: 61 }, b: { soc: 70, age: 0 } });

            const algo1 = new SteeringAlgorithm(makeConfig({ mqtt: mqtt60, correctionK: 0.5 }));
            const algo2 = new SteeringAlgorithm(makeConfig({ mqtt: mqtt61, correctionK: 0.5 }));

            const consumers1 = makeConsumers([{ id: "a" }, { id: "b" }]);
            const consumers2 = makeConsumers([{ id: "a" }, { id: "b" }]);
            algo1.priorityOrder = ["a", "b"];
            algo2.priorityOrder = ["a", "b"];

            algo1.computeTarget(-600, "a", consumers1);
            const target1 = algo1.computeTarget(-600, "a", consumers1);

            algo2.computeTarget(-600, "a", consumers2);
            const target2 = algo2.computeTarget(-600, "a", consumers2);

            const jump = Math.abs(target1 - target2);
            expect(jump).toBeLessThan(50);
        });

        test("freshness at 65s (mid-decy)", () => {
            const mqtt = makeMockMqtt({ a: { soc: 30, age: 65 }, b: { soc: 70, age: 0 } });
            expect(mqtt.freshness("a")).toBeCloseTo(0.83, 1);
        });
    });

    describe("Reactive re-selection", () => {
        test("saturated active battery replaced by next eligible", () => {
            const algo = new SteeringAlgorithm(makeConfig({ minEfficientPower: 150 }));
            const consumers = makeConsumers([
                { id: "a", saturation: 0.95, lastTarget: -200, power: 0 },
                { id: "b", saturation: 0 },
                { id: "c", saturation: 0 }
            ]);
            algo.priorityOrder = ["a", "b", "c"];

            algo.computeTarget(-400, "a", consumers);
            const targetA = algo.computeTarget(-400, "a", consumers);
            const targetB = algo.computeTarget(-400, "b", consumers);

            expect(targetA).toBe(0);
            expect(targetB).not.toBe(0);
        });

        test("multiple saturated batteries replaced correctly", () => {
            const algo = new SteeringAlgorithm(makeConfig({ minEfficientPower: 150 }));
            const consumers = makeConsumers([
                { id: "a", saturation: 0.95, lastTarget: -200, power: 0 },
                { id: "b", saturation: 0.95, lastTarget: -200, power: 0 },
                { id: "c", saturation: 0 },
                { id: "d", saturation: 0 }
            ]);
            algo.priorityOrder = ["a", "b", "c", "d"];

            algo.computeTarget(-400, "a", consumers);
            const targetA = algo.computeTarget(-400, "a", consumers);
            const targetB = algo.computeTarget(-400, "b", consumers);
            const targetC = algo.computeTarget(-400, "c", consumers);
            const targetD = algo.computeTarget(-400, "d", consumers);

            expect(targetA).toBe(0);
            expect(targetB).toBe(0);
            const active = [targetC, targetD].filter(t => t !== 0).length;
            expect(active).toBeGreaterThanOrEqual(1);
        });
    });

    describe("Consumer lifecycle", () => {
        test("battery removed from priorityOrder when offline", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            algo.priorityOrder = ["a", "b", "c"];

            algo.removeOffline(["a", "c"]);
            expect(algo.priorityOrder).toEqual(["a", "c"]);
        });

        test("new battery appended to priorityOrder", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            algo.priorityOrder = ["a", "b"];

            algo.updatePriorityOrder(["c"]);
            expect(algo.priorityOrder).toEqual(["a", "b", "c"]);
        });

        test("existing battery not duplicated", () => {
            const algo = new SteeringAlgorithm(makeConfig());
            algo.priorityOrder = ["a", "b"];

            algo.updatePriorityOrder(["b", "c"]);
            expect(algo.priorityOrder).toEqual(["a", "b", "c"]);
        });
    });
});
