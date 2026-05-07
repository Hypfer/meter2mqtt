const Logger = require("./Logger");

class SteeringAlgorithm {
    constructor(config) {
        // MQTT state provider (can be null for fallback mode)
        this.mqtt = config.mqtt || null;

        // Configuration
        this.deadbandEnter = config.deadbandEnter || 25;
        this.deadbandExit = config.deadbandExit || 15;
        this.alpha = config.alpha || 0.08;
        this.alphaSignFlip = config.alphaSignFlip || 0.32;
        this.maxDev = config.maxDev || 30;
        this.correctionK = config.correctionK || 0.5;
        this.minEfficientPower = config.minEfficientPower || 150;
        this.rotationInterval = config.rotationInterval !== undefined ? config.rotationInterval : 300;
        this.saturationAlpha = config.saturationAlpha || 0.15;

        // EMA state
        this.smoothed = null;
        this.prevSign = 0;
        this.inActive = false;

        // Efficiency rotation
        this.priorityOrder = [];
        this.lastRotation = Date.now();
    }

    // Update priority order when consumers change
    updatePriorityOrder(consumerIds) {
        const existing = new Set(this.priorityOrder);
        for (const id of consumerIds) {
            if (!existing.has(id)) {
                this.priorityOrder.push(id);
            }
        }
    }

    // Remove offline consumers from priority order
    removeOffline(consumerIds) {
        const active = new Set(consumerIds);
        this.priorityOrder = this.priorityOrder.filter(id => active.has(id));
    }

    /**
     * Main entry point. Computes target for a single battery.
     * @param {number} gridTotal - l1 + l2 + l3
     * @param {string} batteryId - requesting battery ID
     * @param {object} consumers - Map of all consumer states
     * @returns {number} target power for this battery
     */
    computeTarget(gridTotal, batteryId, consumers) {
        // Step 1: Deadband check (with hysteresis)
        if (this.inActive) {
            if (Math.abs(gridTotal) < this.deadbandExit) {
                this.inActive = false;
            }
        } else {
            if (Math.abs(gridTotal) >= this.deadbandEnter) {
                this.inActive = true;
            }
        }

        // Step 2: EMA smoothing (always updated)
        this._updateEma(gridTotal);

        if (!this.inActive) {
            return 0;
        }

        // Step 3: Efficiency mode — determine active batteries
        const { activeSlots, nActive } = this._getActiveSlots(consumers);

        // Step 4: Compute fleet average SoC (active batteries only)
        const avgSoc = this._computeAvgSoc(activeSlots);

        // Step 5: Per-battery target computation
        return this._computeBatteryTarget(batteryId, activeSlots, nActive, avgSoc, consumers);
    }

    _updateEma(gridTotal) {
        if (this.smoothed === null) {
            this.smoothed = gridTotal;
            this.prevSign = Math.sign(gridTotal);
            return;
        }

        const currSign = Math.sign(gridTotal);
        const signFlipped = (currSign !== 0) && (this.prevSign !== 0) && (currSign !== this.prevSign);
        const alpha = signFlipped ? this.alphaSignFlip : this.alpha;

        this.smoothed += alpha * (gridTotal - this.smoothed);

        if (currSign !== 0) {
            this.prevSign = currSign;
        }
    }

    _getActiveSlots(consumers) {
        const nTotal = Math.max(1, this.priorityOrder.length);
        const perBattery = Math.abs(this.smoothed) / nTotal;

        let nActive;
        if (perBattery < this.minEfficientPower) {
            nActive = Math.max(1, Math.floor(Math.abs(this.smoothed) / this.minEfficientPower));
        } else {
            nActive = nTotal;
        }

        // SoC-aware selection
        const sorted = this._sortPriorityForActivation(nActive);
        let activeSlots = new Set(sorted.slice(0, nActive));

        // Reactive re-selection: replace saturated active batteries
        activeSlots = this._reactiveReselect(activeSlots, nActive, sorted, consumers);

        return { activeSlots, nActive };
    }

    _sortPriorityForActivation(nActive) {
        if (!this.mqtt || this.mqtt.idToMac.size === 0) {
            return [...this.priorityOrder];
        }

        const isSurplus = this.smoothed < 0;
        const sorted = [...this.priorityOrder].sort((a, b) => {
            const socA = this.mqtt.getSoC(a);
            const socB = this.mqtt.getSoC(b);
            const freshA = this.mqtt.freshness(a);
            const freshB = this.mqtt.freshness(b);

            // Fresh data sorts first
            if (freshA >= 0.1 && freshB < 0.1) return -1;
            if (freshA < 0.1 && freshB >= 0.1) return 1;

            // Both fresh: sort by SoC
            if (socA !== null && socB !== null) {
                if (isSurplus) {
                    return socA - socB; // lower SoC first during charging
                } else {
                    return socB - socA; // higher SoC first during discharging
                }
            }

            // Both stale: keep original order
            return 0;
        });

        return sorted;
    }

    _reactiveReselect(activeSlots, nActive, sorted, consumers) {
        const newActive = new Set();
        const iterator = sorted[Symbol.iterator]();
        let cursor = iterator.next();

        for (const id of activeSlots) {
            if (!this._isSaturated(id, consumers)) {
                newActive.add(id);
            } else {
                // Find next non-saturated battery
                while (cursor && newActive.size < nActive) {
                    if (!activeSlots.has(cursor.value) && !newActive.has(cursor.value) && !this._isSaturated(cursor.value, consumers)) {
                        newActive.add(cursor.value);
                        break;
                    }
                    cursor = iterator.next();
                }
            }
        }

        return newActive.size >= Math.min(1, nActive) ? newActive : activeSlots;
    }

    _isSaturated(batteryId, consumers) {
        const consumer = consumers.get(batteryId);
        return consumer && consumer.saturation > 0.9;
    }

    _computeAvgSoc(activeSlots) {
        if (!this.mqtt) return undefined;

        const fresh = [];
        for (const id of activeSlots) {
            const f = this.mqtt.freshness(id);
            if (f >= 0.1) {
                const soc = this.mqtt.getSoC(id);
                if (soc !== null) {
                    fresh.push({ soc, weight: f });
                }
            }
        }

        if (fresh.length === 0) return undefined;

        const totalWeight = fresh.reduce((sum, b) => sum + b.weight, 0);
        return fresh.reduce((sum, b) => sum + b.soc * b.weight, 0) / totalWeight;
    }

    _computeBatteryTarget(batteryId, activeSlots, nActive, avgSoc, consumers) {
        // 5a: Active check
        if (!activeSlots.has(batteryId)) {
            this._updateSaturation(batteryId, 0, consumers);
            return 0;
        }

        // 5b: Base fair share
        const base = this.smoothed / nActive;

        // 5c: SoC deviation correction
        const freshness = this.mqtt ? this.mqtt.freshness(batteryId) : 0;
        let correction = 0;

        if (avgSoc !== undefined && freshness >= 0.1) {
            const soc = this.mqtt.getSoC(batteryId);
            if (soc !== null) {
                const dev = soc - avgSoc;
                correction = this.correctionK * (dev / 100) * Math.abs(base);
            }
        }

        // 5d: SoC blend weight
        let w = 1.0;
        if (avgSoc !== undefined && freshness >= 0.1) {
            const soc = this.mqtt.getSoC(batteryId);
            if (soc !== null) {
                const dev = soc - avgSoc;
                w = Math.max(0, 1 - Math.abs(dev) / this.maxDev);
            }
        }

        // 5e: Correction cap
        if (nActive > 1) {
            const maxCorrection = Math.abs(base) - this.minEfficientPower;
            if (maxCorrection > 0) {
                correction = Math.max(-maxCorrection, Math.min(maxCorrection, correction));
            } else {
                correction = 0;
            }
        }

        // 5f: Blend
        let target = w * base + (1 - w) * (base + correction);

        // Step 6: Direction clamp
        if ((this.smoothed < 0 && target > 0) || (this.smoothed > 0 && target < 0)) {
            target = 0;
        }

        // Step 7: Power limit clamping
        if (this.mqtt && freshness >= 0.1) {
            const limits = this.mqtt.getLimits(batteryId);
            if (limits) {
                if (this.smoothed < 0 && limits.setChargePower !== null && limits.setChargePower >= 0) {
                    target = Math.max(target, -limits.setChargePower);
                }
                if (this.smoothed > 0 && limits.setDischargePower !== null && limits.setDischargePower >= 0) {
                    target = Math.min(target, limits.setDischargePower);
                }
            }
        }

        // Behavioral saturation (independent of MQTT)
        const consumer = consumers.get(batteryId);
        if (consumer && consumer.saturation > 0.9) {
            target = 0;
        }

        // Update behavioral saturation tracking
        this._updateSaturation(batteryId, target, consumers);

        return target;
    }

    _updateSaturation(batteryId, target, consumers) {
        const consumer = consumers.get(batteryId);
        if (!consumer) return;

        if (consumer.lastTarget === null) return;
        const targetAbs = Math.abs(consumer.lastTarget);
        if (targetAbs < 20) return;

        // Sign reversal — reset saturation
        const signMismatch = (consumer.lastTarget > 0 && consumer.power < 0) ||
                             (consumer.lastTarget < 0 && consumer.power > 0);
        if (signMismatch) {
            consumer.saturation = 0;
            consumer.lastTarget = target;
            return;
        }

        const followRatio = Math.min(1.0, Math.abs(consumer.power) / targetAbs);
        consumer.saturation = this.saturationAlpha * (1.0 - followRatio) + (1 - this.saturationAlpha) * consumer.saturation;
        consumer.lastTarget = target;
    }

    // Trigger efficiency rotation
    maybeRotate() {
        if (this.priorityOrder.length <= 1) return;
        const now = Date.now();
        if (now - this.lastRotation < this.rotationInterval * 1000) return;

        this.priorityOrder.push(this.priorityOrder.shift());
        this.lastRotation = now;
        Logger.info(`Steering: rotated priority. Order: [${this.priorityOrder.join(', ')}]`);
    }
}

module.exports = SteeringAlgorithm;
