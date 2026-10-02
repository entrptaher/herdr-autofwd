// @ts-check
// The demos' pretend machines answer like the daemon: clashes move and say why, taken ports are refused.
import assert from "node:assert/strict";
import test from "node:test";
import { createSim } from "../demo/sim.js";

test("demo sim: a clash moves to the next free port and the form refuses a taken one", async () => {
  const sim = createSim(["a", "b"], { 8080: "node (pid 1) on this computer" });
  sim.listen("a", 5173, "vite");
  sim.listen("b", 5173, "vite");
  sim.listen("b", 8080, "jupyter");
  const [clash, behindLocal] = sim.state.machines[1].ports;
  assert.equal(clash.local, 5174);
  assert.equal(clash.note, "localhost:5173 is used by the forward from a (5173)");
  assert.equal(behindLocal.local, 8081);
  assert.equal(behindLocal.note, "localhost:8080 is used by node (pid 1) on this computer");

  const refused = await sim.api.act({ op: "save", machine: "b", dest: "localhost:5173", to: "5173", local: 5173 });
  assert.deepEqual(refused, { ok: false, message: "localhost:5173 is already used by the forward from a (5173). Pick another local port." });
  await sim.api.act({ op: "save", machine: "b", dest: "localhost:5173", to: "5173", local: 6000 });
  assert.equal(clash.local, 6000);

  sim.close("a", 5173);
  assert.deepEqual(sim.state.machines[0].ports, []);
  sim.reset();
  assert.deepEqual(sim.state.machines[1].ports, []);
});
