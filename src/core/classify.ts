// Turn a raw netlist into a classified Design: component roles, net classes,
// functional clusters (buck/usb/rf/sensor/motor), routing priorities, footprints.

import { footprintGeom } from "./footprints";
import { RawComponent, RawNetlist } from "./schematic";
import {
  BoardSpec, Cluster, CompPin, Component, Design, Net, NetClass, Role,
} from "./types";

function refPrefix(ref: string): string {
  const m = ref.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "";
}

function classifyRole(c: RawComponent, netsOf: string[]): Role {
  const p = refPrefix(c.ref);
  const v = (c.value || "").toLowerCase();
  const fp = (c.footprint || c.libId || "").toLowerCase();
  const nets = netsOf.map((n) => n.toLowerCase());
  const has = (frag: string) => nets.some((n) => n.includes(frag));

  if (p === "ANT" || fp.includes("antenna") || v.includes("antenna")) return "antenna";
  if (p === "Y" || p === "X" || fp.includes("crystal") || v.includes("mhz") && p === "Y") return "crystal";
  if (p === "TP") return "testpoint";
  if (p === "H" || fp.includes("mounting")) return "mounting";
  if (p === "F") return "fuse";
  if (p === "L") return "inductor";
  if (p === "D") return v.includes("led") || fp.includes("led") ? "led" : "diode";
  if (p === "Q" || p === "M") return "mosfet";
  if (p === "J" || p === "P") return fp.includes("usb") || v.includes("usb") ? "usb" : "connector";
  if (p === "R") return "resistor";
  if (p === "C") {
    if (has("vin") || has("vbus") || has("vbat")) return "input_cap";
    if (has("sw") || has("3v3") || has("vout") || has("5v")) return "output_cap";
    return "decap";
  }
  if (p === "U") {
    if (v.includes("esp") || v.includes("stm") || v.includes("rp2") || v.includes("mcu") || v.includes("samd") || v.includes("nrf")) return "mcu";
    if (v.includes("tps") || v.includes("buck") || v.includes("reg") || v.includes("mp") || v.includes("lm") || has("sw")) return "regulator";
    if (v.includes("imu") || v.includes("mpu") || v.includes("icm") || v.includes("lsm") || v.includes("bmi")) return "imu";
    if (v.includes("adc") || v.includes("ads")) return "adc";
    if (v.includes("drv") || v.includes("motor") || v.includes("driver") || has("motor")) return "motor_driver";
    if (v.includes("esd") || v.includes("usblc")) return "diode";
    if (v.includes("rf") || v.includes("lora") || v.includes("nrf24") || v.includes("sx12")) return "rf";
    if (v.includes("sensor") || v.includes("bme") || v.includes("sht")) return "sensor";
    return "ic";
  }
  return "passive";
}

function classifyNet(name: string): { classes: NetClass[]; priority: number; currentA?: number } {
  const n = name.toLowerCase();
  const classes: NetClass[] = [];
  let priority = 2;
  let currentA: number | undefined;
  if (/^(gnd|agnd|pgnd|dgnd|ground)/.test(n)) { classes.push("ground"); priority = 1; }
  else if (/(vin|vbat|vbus|vmot|motor|12v|24v|vsys)/.test(n)) { classes.push("high_current", "power"); priority = 9; currentA = 1.5; }
  else if (/(sw|phase|gate|boot|lx)/.test(n)) { classes.push("noisy"); priority = 8; }
  else if (/(usb_d|usbd|dp|dm|d\+|d-)/.test(n)) { classes.push("usb", "sensitive"); priority = 7; }
  else if (/(xtal|xin|xout|osc|clk)/.test(n)) { classes.push("clock", "sensitive"); priority = 6; }
  else if (/(rf|ant)/.test(n)) { classes.push("rf", "sensitive"); priority = 7; }
  else if (/(adc|ain|sense|imu|sda|scl|sck|miso|mosi|analog|ref)/.test(n)) { classes.push("sensitive"); priority = 4; }
  else if (/(3v3|5v|1v8|vcc|vdd|vout|3\.3|pwr)/.test(n)) { classes.push("power"); priority = 5; }
  else { classes.push("signal"); priority = 2; }
  return { classes, priority, currentA };
}

export function buildDesign(raw: RawNetlist, board: BoardSpec): Design {
  // nets
  const nets: Net[] = raw.nets.map((rn, i) => {
    const cl = classifyNet(rn.name);
    return { name: rn.name, code: i + 1, pins: rn.pins, classes: cl.classes, priority: cl.priority, currentA: cl.currentA };
  });
  const netClassByName = new Map(nets.map((n) => [n.name, n]));

  // pin -> net lookup
  const pinToNet = new Map<string, string>();
  for (const n of nets) for (const pr of n.pins) pinToNet.set(`${pr.ref}:${pr.pad}`, n.name);

  // components
  const footprints: Record<string, any> = {};
  const components: Component[] = raw.components.map((rc) => {
    const pins: CompPin[] = rc.pins.map((p) => ({
      num: p.num, name: p.name, net: pinToNet.get(`${rc.ref}:${p.num}`) || "",
    }));
    const netsOf = pins.map((p) => p.net).filter(Boolean);
    const role = classifyRole(rc, netsOf);
    footprints[rc.ref] = footprintGeom(rc.footprint || rc.libId, rc.value, rc.pins.map((p) => p.num), rc.ref);
    return { ref: rc.ref, value: rc.value, libId: rc.footprint || rc.libId, pins, role };
  });

  const clusters = detectClusters(components, netClassByName);
  for (const cl of clusters) for (const ref of cl.refs) {
    const c = components.find((x) => x.ref === ref);
    if (c && !c.clusterId) c.clusterId = cl.id;
  }

  return { name: board.name, components, nets, clusters, board, footprints };
}

function netsOfComp(c: Component): Set<string> {
  return new Set(c.pins.map((p) => p.net).filter(Boolean));
}

function detectClusters(components: Component[], nets: Map<string, Net>): Cluster[] {
  const clusters: Cluster[] = [];
  let id = 0;

  // Buck converter: regulator + inductor + nearby caps + diode/mosfet sharing sw/vin
  const regulators = components.filter((c) => c.role === "regulator");
  for (const reg of regulators) {
    const rnets = netsOfComp(reg);
    const members = new Set<string>([reg.ref]);
    const swNet = [...rnets].find((n) => /sw|lx|phase/i.test(n));
    for (const c of components) {
      if (c === reg) continue;
      const cn = netsOfComp(c);
      const shares = [...cn].some((n) => rnets.has(n));
      if (!shares) continue;
      if (["inductor", "input_cap", "output_cap", "diode", "mosfet", "decap"].includes(c.role)) {
        members.add(c.ref);
      }
    }
    const critical = [...rnets].filter((n) => {
      const net = nets.get(n);
      return net && (net.classes.includes("noisy") || net.classes.includes("high_current") || net.classes.includes("power"));
    });
    clusters.push({ id: `buck_${id++}`, kind: "buck_converter", refs: [...members], criticalNets: critical, objective: "minimize_switch_loop_area" });
  }

  // USB section
  const usbConn = components.filter((c) => c.role === "usb");
  for (const j of usbConn) {
    const members = new Set<string>([j.ref]);
    const jn = netsOfComp(j);
    for (const c of components) {
      if (c === j) continue;
      const cn = netsOfComp(c);
      if ([...cn].some((n) => jn.has(n)) && (c.role === "diode" || c.role === "resistor" || c.role === "mcu")) {
        if (c.role !== "mcu") members.add(c.ref);
      }
    }
    clusters.push({ id: `usb_${id++}`, kind: "usb_section", refs: [...members], criticalNets: [...jn].filter((n) => /usb|dp|dm/i.test(n)) });
  }

  // RF / antenna section
  const antennas = components.filter((c) => c.role === "antenna" || c.role === "rf");
  for (const a of antennas) {
    clusters.push({ id: `rf_${id++}`, kind: "rf_section", refs: [a.ref], criticalNets: [...netsOfComp(a)] });
  }

  // Sensor section (imu/adc/sensor + their decaps)
  const sensors = components.filter((c) => ["imu", "adc", "sensor"].includes(c.role));
  for (const s of sensors) {
    const members = new Set<string>([s.ref]);
    const sn = netsOfComp(s);
    for (const c of components) {
      if (c.role === "decap" && [...netsOfComp(c)].some((n) => sn.has(n))) members.add(c.ref);
    }
    clusters.push({ id: `sensor_${id++}`, kind: "sensor_section", refs: [...members], criticalNets: [...sn] });
  }

  // Motor power section
  const drivers = components.filter((c) => c.role === "motor_driver");
  for (const d of drivers) {
    const members = new Set<string>([d.ref]);
    const dn = netsOfComp(d);
    for (const c of components) {
      if ((c.role === "mosfet" || c.role === "connector" || c.role === "input_cap") && [...netsOfComp(c)].some((n) => dn.has(n))) members.add(c.ref);
    }
    clusters.push({ id: `motor_${id++}`, kind: "motor_power", refs: [...members], criticalNets: [...dn].filter((n) => /motor|vmot|vin|gate/i.test(n)) });
  }

  return clusters;
}
