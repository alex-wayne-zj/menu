// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend } from "./recommend.ts";
const foods = [
  { id: 1, kind: "meat" },
  { id: 2, kind: "vegetable" },
  { id: 3, kind: "other" },
  { id: 4, kind: "meat" },
];
test("empty and all selected never return selected", () => {
  assert.equal(recommend([], []).dish, null);
  assert.equal(recommend(foods, foods).dish, null);
});
test("missing kind is preferred", () => {
  assert.equal(recommend(foods, [foods[0]], undefined, () => 0).dish.id, 2);
  assert.equal(recommend(foods, [foods[1]], undefined, () => 0).dish.id, 1);
});
test("neither, both and other only use ordinary pool", () => {
  assert.equal(recommend(foods, [], undefined, () => 0.7).dish.id, 3);
  assert.equal(
    recommend(foods, foods.slice(0, 2), undefined, () => 0).dish.id,
    3,
  );
  assert.equal(recommend(foods, [foods[2]], undefined, () => 0).dish.id, 1);
});
test("missing type falls back visibly within filter", () => {
  const r = recommend([foods[2]], [foods[0]]);
  assert.equal(r.dish.id, 3);
  assert.match(r.message, /没有素菜/);
});
test("change avoids previous within priority pool; one allows repeat", () => {
  assert.equal(recommend(foods, [foods[1]], 1, () => 0).dish.id, 4);
  const r = recommend([foods[0]], [], 1);
  assert.equal(r.dish.id, 1);
  assert.match(r.message, /仅此一道/);
});
