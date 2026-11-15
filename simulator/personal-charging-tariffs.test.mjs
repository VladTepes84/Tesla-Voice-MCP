import test from 'node:test';
import assert from 'node:assert/strict';
import {compareChargingCosts,chargingCostTool} from './lib/charge-cost-comparison.mjs';
import {chargingRouteTool} from './lib/charging-route.mjs';
test('public MCP does not expose saved personal tariffs',()=>{
 assert.equal(Object.hasOwn(chargingRouteTool.inputSchema.properties,'personalTariffs'),false);
 assert.equal(Object.hasOwn(chargingRouteTool.inputSchema.properties,'freeToXTariff'),false);
 assert.equal(Object.hasOwn(chargingCostTool.inputSchema.properties,'station'),false);
 assert.throws(()=>compareChargingCosts({station:{operator:'Example'},energyToBatteryKwh:20}),/invalid_charging_cost_inputs/);
});
