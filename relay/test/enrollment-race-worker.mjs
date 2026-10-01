import "./source-loader.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { sqliteRegistry } from "./enrollment-sqlite.mjs";
const { redeemEnrollmentInvite } = await import("../src/beta-enrollment.ts");
const { db, registry } = sqliteRegistry(workerData.file, { migrate: false });
const barrier = new Int32Array(workerData.barrier);
parentPort.postMessage("ready");
Atomics.wait(barrier, 0, 0);
try {
  parentPort.postMessage(await redeemEnrollmentInvite(registry, workerData.invite, workerData.registration, [], workerData.now, workerData.origin));
} finally { db.close(); }
