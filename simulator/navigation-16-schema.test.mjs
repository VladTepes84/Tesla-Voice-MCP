import test from 'node:test';
import assert from 'node:assert/strict';
import { smartTripTool } from './lib/smart-trip.mjs';

test('plan_smart_trip exposes 16 navigation destinations in its public tool schema', () => {
  const schema = smartTripTool.inputSchema.properties;
  assert.equal(schema.stops.maxItems, 15, '15 stops plus final destination');
  for (const key of ['placeSelections', 'placeCorrections']) {
    assert.equal(schema[key].maxItems, 16);
    assert.equal(schema[key].items.properties.placeIndex.maximum, 15);
  }
});
