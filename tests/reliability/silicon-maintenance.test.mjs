import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  maintenanceQueueAcknowledgement,
  maintenanceDefersDelivery,
  siliconMaintenancePeers,
  siliconMaintenanceRoomMessage,
  siliconPeerProjectionSignature,
} from "../../src/lib/silicon-maintenance.ts";

const roomViewSource = await readFile(
  new URL("../../src/components/chat/room-view.tsx", import.meta.url),
  "utf8",
);

function silicon(name, phase, revision, overrides = {}) {
  return {
    kind: "silicon",
    id: name.toLowerCase(),
    handle: name.toLowerCase(),
    name,
    profile_photo_url: null,
    connection_state: "offline",
    maintenance: {
      active: true,
      delivery_deferred: true,
      phase,
      update_id: "update-1",
      target_version: "2.0.0",
      queued_count: 0,
      revision,
      message: "",
      started_at: null,
      updated_at: null,
      lease_expires_at: null,
      ...overrides,
    },
  };
}

test("direct and group copy names every affected Silicon and active phase", () => {
  const ada = silicon("Ada", "updating", 2);
  const turing = silicon("Turing", "validating", 4);

  assert.match(siliconMaintenanceRoomMessage([ada]), /Ada is installing the update/);
  assert.match(
    siliconMaintenanceRoomMessage([ada, turing]),
    /Ada: installing the update; Turing: validating the new version/,
  );
  assert.match(siliconMaintenanceRoomMessage([ada, turing]), /do not need to resend/i);
});

test("a recently expired updater lease remains visibly delivery-deferred", () => {
  const recovering = silicon("Ada", "status_unknown", 5, {
    active: false,
    delivery_deferred: true,
    message:
      "Silicon's update status is reconnecting. Your message will be delivered automatically.",
  });

  assert.equal(maintenanceDefersDelivery(recovering.maintenance), true);
  assert.deepEqual(siliconMaintenancePeers([recovering]), [recovering]);
  assert.match(
    siliconMaintenanceRoomMessage([recovering]),
    /Ada is reconnecting its update status/,
  );
});

test("poll snapshots cannot mask a newer websocket maintenance revision", () => {
  const before = [silicon("Ada", "updating", 2)];
  const after = [silicon("Ada", "validating", 3)];

  assert.notEqual(
    siliconPeerProjectionSignature(before),
    siliconPeerProjectionSignature(after),
  );
});

test("forwarded event batches surface the server's do-not-resend acknowledgement", () => {
  const projection = silicon("Ada", "updating", 2).maintenance;
  const acknowledgement = maintenanceQueueAcknowledgement([
    {
      delivery_state: "queued_for_maintenance",
      delivery_acknowledgement:
        "Your message is safely stored. You do not need to resend it.",
      maintenance_recipients: [{ ...projection, name: "Ada" }],
    },
  ]);

  assert.deepEqual(acknowledgement, {
    message: "Your message is safely stored. You do not need to resend it.",
    recipientNames: ["Ada"],
  });
});

test("room maintenance recovery polls groups and exposes an atomic live region", () => {
  assert.match(
    roomViewSource,
    /next\.peers\.filter\(\(item\) => item\.kind === "silicon"\)/,
  );
  assert.match(roomViewSource, /window\.setInterval\(poll, 5000\)/);
  assert.match(
    roomViewSource,
    /role="status"\s+aria-live="polite"\s+aria-atomic="true"/,
  );
});
