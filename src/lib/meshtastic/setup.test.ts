import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { Admin, Channel, Config, Mesh, ModuleConfig, Portnums } from "@meshtastic/protobufs";
import type { BleEvent } from "../ble/transport.ts";
import { MeshLink } from "./link.ts";
import {
  FULL_PRECISION_BITS,
  base64ToKey,
  buildBoardWrites,
  bytesToBase64,
  checkPlan,
  differences,
  generateKey,
  summarize,
  type BoardPlan,
} from "./setup.ts";
import { toBinary } from "@bufbuild/protobuf";

function plan(overrides: Partial<BoardPlan> = {}): BoardPlan {
  return {
    channelName: "Excursion",
    key: new Uint8Array(32).fill(7),
    positionSecs: 30,
    gpsUpdateSecs: 15,
    okButtonPin: 5,
    ...overrides,
  };
}

function boardPosition(): Config.Config_PositionConfig {
  return create(Config.Config_PositionConfigSchema, {
    gpsMode: Config.Config_PositionConfig_GpsMode.ENABLED,
    rxGpio: 39,
    txGpio: 38,
    positionFlags: 811,
    positionBroadcastSecs: 900,
    positionBroadcastSmartEnabled: true,
    gpsUpdateInterval: 120,
  });
}

describe("buildBoardWrites", () => {
  it("changes only the reporting fields and keeps the board's GPS wiring and mode", () => {
    const writes = buildBoardWrites({ position: boardPosition() }, plan());
    assert.equal(writes.position.payloadVariant.case, "position");
    if (writes.position.payloadVariant.case !== "position") return;
    const position = writes.position.payloadVariant.value;
    assert.equal(position.gpsMode, Config.Config_PositionConfig_GpsMode.ENABLED);
    assert.equal(position.rxGpio, 39);
    assert.equal(position.txGpio, 38);
    assert.equal(position.positionFlags, 811);
    assert.equal(position.positionBroadcastSecs, 30);
    assert.equal(position.positionBroadcastSmartEnabled, false);
    assert.equal(position.gpsUpdateInterval, 15);
  });

  it("turns GPS on when the board had it disabled", () => {
    const off = boardPosition();
    off.gpsMode = Config.Config_PositionConfig_GpsMode.DISABLED;
    const writes = buildBoardWrites({ position: off }, plan());
    if (writes.position.payloadVariant.case !== "position") assert.fail("no position");
    assert.equal(writes.position.payloadVariant.value.gpsMode, Config.Config_PositionConfig_GpsMode.ENABLED);
  });

  it("sets the private primary channel with full precision", () => {
    const writes = buildBoardWrites({ position: boardPosition() }, plan({ channelName: "  Team5 " }));
    assert.equal(writes.channel.index, 0);
    assert.equal(writes.channel.role, Channel.Channel_Role.PRIMARY);
    assert.equal(writes.channel.settings?.name, "Team5");
    assert.deepEqual(writes.channel.settings?.psk, new Uint8Array(32).fill(7));
    assert.equal(writes.channel.settings?.moduleSettings?.positionPrecision, FULL_PRECISION_BITS);
    assert.equal(writes.channel.settings?.uplinkEnabled, false);
  });

  it("turns on the OK button with no periodic message", () => {
    const writes = buildBoardWrites({ position: boardPosition() }, plan({ okButtonPin: 5 }));
    assert.ok(writes.detection);
    if (writes.detection?.payloadVariant.case !== "detectionSensor") assert.fail("no detection sensor");
    const sensor = writes.detection.payloadVariant.value;
    assert.equal(sensor.enabled, true);
    assert.equal(sensor.monitorPin, 5);
    assert.equal(sensor.name, "OK");
    assert.equal(sensor.usePullup, true);
    assert.equal(sensor.stateBroadcastSecs, 0);
    assert.equal(sensor.detectionTriggerType, ModuleConfig.ModuleConfig_DetectionSensorConfig_TriggerType.FALLING_EDGE);
  });

  it("leaves the OK button alone when no pin is given", () => {
    assert.equal(buildBoardWrites({ position: boardPosition() }, plan({ okButtonPin: null })).detection, null);
  });

  it("refuses before the board's settings arrive", () => {
    assert.throws(() => buildBoardWrites({}, plan()), /Still reading/);
  });
});

describe("checkPlan", () => {
  it("rejects a long name, a bad key, a slow interval, and a pin the board uses", () => {
    assert.match(checkPlan(plan({ channelName: "TwelveChars!" })) ?? "", /11 characters/);
    assert.match(checkPlan(plan({ key: new Uint8Array(1) })) ?? "", /key/);
    assert.match(checkPlan(plan({ positionSecs: 5 })) ?? "", /Position interval/);
    assert.match(checkPlan(plan({ okButtonPin: 38 })) ?? "", /GPS/);
    assert.match(checkPlan(plan({ okButtonPin: 0 })) ?? "", /PRG/);
    assert.equal(checkPlan(plan()), null);
  });
});

describe("team key", () => {
  it("round-trips through base64 and rejects other lengths", () => {
    const key = generateKey();
    assert.equal(key.length, 32);
    assert.deepEqual(base64ToKey(bytesToBase64(key)), key);
    assert.equal(base64ToKey("AQ=="), null);
    assert.equal(base64ToKey("not base64!"), null);
  });
});

describe("differences", () => {
  it("lists what a stock board is missing and nothing once it matches", () => {
    const stock = summarize({
      position: boardPosition(),
      channel: create(Channel.ChannelSchema, {
        index: 0,
        settings: create(Channel.ChannelSettingsSchema, { name: "", psk: new Uint8Array([1]) }),
      }),
    });
    const found = differences(stock, plan());
    assert.ok(found.some((item) => /Channel is/.test(item)));
    assert.ok(found.some((item) => /key/.test(item)));
    assert.ok(found.some((item) => /precision/.test(item)));
    assert.ok(found.some((item) => /Smart position/.test(item)));
    assert.ok(found.some((item) => /OK button is off/.test(item)));

    const writes = buildBoardWrites({ position: boardPosition() }, plan());
    if (writes.position.payloadVariant.case !== "position") assert.fail("no position");
    if (writes.detection?.payloadVariant.case !== "detectionSensor") assert.fail("no detection");
    const done = summarize({
      position: writes.position.payloadVariant.value,
      channel: writes.channel,
      detection: writes.detection.payloadVariant.value,
    });
    assert.deepEqual(differences(done, plan()), []);
  });
});

describe("MeshLink.setUpBoard", () => {
  it("reads the board, writes position, channel and OK button, then commits", async () => {
    const admin: Admin.AdminMessage[] = [];
    const events: BleEvent[] = [];
    let link: MeshLink | null = null;
    link = new MeshLink(
      async (bytes) => {
        const toRadio = fromBinary(Mesh.ToRadioSchema, bytes);
        if (toRadio.payloadVariant.case !== "packet") return;
        const packet = toRadio.payloadVariant.value;
        if (packet.payloadVariant.case !== "decoded") return;
        if (packet.payloadVariant.value.portnum !== Portnums.PortNum.ADMIN_APP) return;
        admin.push(fromBinary(Admin.AdminMessageSchema, packet.payloadVariant.value.payload));
        // The board acknowledges each admin write from itself.
        const ack = toBinary(
          Mesh.RoutingSchema,
          create(Mesh.RoutingSchema, { variant: { case: "errorReason", value: Mesh.Routing_Error.NONE } }),
        );
        setTimeout(() => {
          link?.push(
            toBinary(
              Mesh.FromRadioSchema,
              create(Mesh.FromRadioSchema, {
                payloadVariant: {
                  case: "packet",
                  value: create(Mesh.MeshPacketSchema, {
                    from: 0x11,
                    to: 0x11,
                    id: 1,
                    payloadVariant: {
                      case: "decoded",
                      value: create(Mesh.DataSchema, {
                        portnum: Portnums.PortNum.ROUTING_APP,
                        requestId: packet.id,
                        payload: ack,
                      }),
                    },
                  }),
                },
              }),
            ),
          );
        }, 5);
      },
      (event) => events.push(event),
    );
    const push = (payloadVariant: Mesh.FromRadio["payloadVariant"]) =>
      link?.push(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant })));
    push({ case: "myInfo", value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0x11 }) });
    push({
      case: "config",
      value: create(Config.ConfigSchema, { payloadVariant: { case: "position", value: boardPosition() } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(events.some((event) => event.type === "board-settings" && event.settings.positionSecs === 900));

    await link.setUpBoard(plan());
    const cases = admin.map((message) => message.payloadVariant.case);
    assert.deepEqual(cases, ["beginEditSettings", "setConfig", "setChannel", "setModuleConfig", "commitEditSettings"]);
    const setConfig = admin.find((message) => message.payloadVariant.case === "setConfig");
    if (setConfig?.payloadVariant.case !== "setConfig") assert.fail("no setConfig");
    const config = setConfig.payloadVariant.value;
    if (config.payloadVariant.case !== "position") assert.fail("not position");
    assert.equal(config.payloadVariant.value.rxGpio, 39);
    assert.equal(config.payloadVariant.value.positionBroadcastSecs, 30);
  });
});
