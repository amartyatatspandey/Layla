// Generate the bundled example .kicad_sch files + their board config.
import * as fs from "fs";
import * as path from "path";
import { genSchematic, PartSpec, SchSpec } from "../core/schemgen";

const EX_DIR = path.join(__dirname, "..", "..", "examples");

let gx = 0, gy = 0;
function nextPos(): { x: number; y: number } {
  const p = { x: 30 + gx * 35, y: 30 + gy * 35 };
  gx++;
  if (gx >= 6) { gx = 0; gy++; }
  return p;
}
function resetGrid() { gx = 0; gy = 0; }

// compact part builder: pins is padNum -> net (name defaults to net)
function part(ref: string, value: string, symName: string, footprint: string, pins: Record<string, string>): PartSpec {
  const at = nextPos();
  const pinObj: PartSpec["pins"] = {};
  for (const [num, net] of Object.entries(pins)) pinObj[num] = { name: net, net };
  return { ref, value, symName, footprint, at, pins: pinObj };
}

interface ExampleDef {
  name: string;
  title: string;
  board: { width: number; height: number; diffPairs?: { p: string; n: string; spacing: number }[] };
  parts: PartSpec[];
  description: string;
}

function buckImu(): ExampleDef {
  resetGrid();
  const parts: PartSpec[] = [
    part("U1", "ESP32-S3", "MCU", "Package_QFN:QFN-56-1EP_7x7mm", {
      "1": "3V3", "2": "GND", "3": "USB_DP", "4": "USB_DM", "5": "IMU_SDA",
      "6": "IMU_SCL", "7": "XTAL1", "8": "XTAL2", "9": "3V3", "10": "GND",
      "11": "EN", "12": "GPIO0",
    }),
    part("U2", "TPS62160", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", {
      "1": "SW", "2": "GND", "3": "FB_3V3", "4": "EN", "5": "VIN", "6": "GND",
    }),
    part("L1", "2.2uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW", "2": "3V3" }),
    part("C1", "10uF", "C", "Capacitor_SMD:C_0805", { "1": "VIN", "2": "GND" }),
    part("C2", "22uF", "C", "Capacitor_SMD:C_0805", { "1": "3V3", "2": "GND" }),
    part("R1", "100k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "FB_3V3" }),
    part("R2", "33k", "R", "Resistor_SMD:R_0402", { "1": "FB_3V3", "2": "GND" }),
    part("C3", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("C4", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("J1", "USB_C", "USB", "Connector_USB:USB_C_Receptacle", {
      "1": "GND", "2": "VIN", "4": "USB_DP", "5": "USB_DM", "9": "GND", "10": "GND",
    }),
    part("U4", "USBLC6", "Diode", "Package_TO_SOT_SMD:SOT-23-6", {
      "1": "USB_DP", "2": "GND", "3": "USB_DM", "4": "USB_DP", "5": "VIN", "6": "USB_DM",
    }),
    part("U3", "ICM42688", "IMU", "Package_QFN:QFN-24_3x3mm", {
      "1": "3V3", "2": "GND", "3": "IMU_SDA", "4": "IMU_SCL", "5": "3V3", "6": "GND",
    }),
    part("C5", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("Y1", "40MHz", "Crystal", "Crystal:Crystal_SMD_3225", {
      "1": "XTAL1", "2": "GND", "3": "XTAL2", "4": "GND",
    }),
    part("TP1", "3V3", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "3V3" }),
    part("TP2", "GND", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "GND" }),
  ];
  return {
    name: "buck_imu", title: "Buck + ESP32 + IMU sensor board",
    board: { width: 52, height: 40, diffPairs: [{ p: "USB_DP", n: "USB_DM", spacing: 0.18 }] },
    parts,
    description: "ESP32-S3 with a TPS62160 buck regulator, USB-C, an ICM-42688 IMU and a 40MHz crystal. The buck switching node and the sensitive IMU/USB nets must be kept apart.",
  };
}

function motorDriver(): ExampleDef {
  resetGrid();
  const parts: PartSpec[] = [
    part("U1", "STM32G0", "MCU", "Package_QFP:LQFP-48", {
      "1": "3V3", "2": "GND", "3": "PWM_A", "4": "PWM_B", "5": "ISENSE",
      "6": "IMU_SDA", "7": "IMU_SCL", "8": "USB_DP", "9": "USB_DM", "10": "GND",
    }),
    part("U2", "DRV8313", "MotorDriver", "Package_QFP:HTSSOP-28", {
      "1": "VMOT", "2": "GND", "3": "PWM_A", "4": "PWM_B", "5": "MOTOR_A",
      "6": "MOTOR_B", "7": "GATE", "8": "GND",
    }),
    part("U3", "TPS54331", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", {
      "1": "SW", "2": "GND", "3": "3V3", "4": "EN", "5": "VMOT", "6": "GND",
    }),
    part("L1", "10uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW", "2": "3V3" }),
    part("C1", "47uF", "C", "Capacitor_SMD:C_1206", { "1": "VMOT", "2": "GND" }),
    part("C2", "22uF", "C", "Capacitor_SMD:C_0805", { "1": "3V3", "2": "GND" }),
    part("Q1", "NMOS", "Mosfet", "Package_TO_SOT_SMD:SOT-23", { "1": "GATE", "2": "MOTOR_A", "3": "GND" }),
    part("J1", "PWR", "Conn", "Connector:ScrewTerminal_1x02_P5.0mm", { "1": "VMOT", "2": "GND" }),
    part("J2", "MOTOR", "Conn", "Connector:ScrewTerminal_1x03_P5.0mm", { "1": "MOTOR_A", "2": "MOTOR_B", "3": "GND" }),
    part("U4", "INA240", "ADC", "Package_TO_SOT_SMD:SOT-23-6", {
      "1": "ISENSE", "2": "GND", "3": "MOTOR_A", "4": "MOTOR_B", "5": "3V3", "6": "ISENSE",
    }),
    part("C3", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("C4", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("J3", "USB_C", "USB", "Connector_USB:USB_C_Receptacle", {
      "1": "GND", "2": "VMOT", "4": "USB_DP", "5": "USB_DM", "9": "GND",
    }),
  ];
  return {
    name: "motor_driver", title: "BLDC motor driver board",
    board: { width: 64, height: 46, diffPairs: [{ p: "USB_DP", n: "USB_DM", spacing: 0.18 }] },
    parts,
    description: "STM32G0 + DRV8313 motor driver with a buck regulator and an INA240 current sensor. High-current motor nets and the buck must stay away from the sense/logic.",
  };
}

function rfSensor(): ExampleDef {
  resetGrid();
  const parts: PartSpec[] = [
    part("U1", "nRF52840", "MCU", "Package_QFN:QFN-48", {
      "1": "3V3", "2": "GND", "3": "RF", "4": "SDA", "5": "SCL",
      "6": "XTAL1", "7": "XTAL2", "8": "3V3", "9": "GND", "10": "SWDIO",
    }),
    part("ANT1", "2.4GHz", "Antenna", "RF_Antenna:Antenna_Chip", { "1": "RF" }),
    part("U2", "MP2359", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", {
      "1": "SW", "2": "GND", "3": "3V3", "4": "EN", "5": "VBAT", "6": "GND",
    }),
    part("L1", "4.7uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW", "2": "3V3" }),
    part("C1", "10uF", "C", "Capacitor_SMD:C_0805", { "1": "VBAT", "2": "GND" }),
    part("C2", "10uF", "C", "Capacitor_SMD:C_0805", { "1": "3V3", "2": "GND" }),
    part("U3", "BME280", "Sensor", "Package_LGA:LGA-8", { "1": "3V3", "2": "GND", "3": "SDA", "4": "SCL" }),
    part("C3", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("C4", "100nF", "C", "Capacitor_SMD:C_0402", { "1": "3V3", "2": "GND" }),
    part("Y1", "32MHz", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "XTAL1", "2": "GND", "3": "XTAL2", "4": "GND" }),
    part("J1", "BATT", "Conn", "Connector:PinHeader_1x02", { "1": "VBAT", "2": "GND" }),
    part("R1", "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SDA" }),
    part("R2", "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SCL" }),
  ];
  return {
    name: "rf_sensor", title: "BLE RF sensor board",
    board: { width: 46, height: 34 },
    parts,
    description: "nRF52840 BLE SoC with a chip antenna, a buck regulator and a BME280 environmental sensor. The antenna needs a clear board-edge keepout away from the switching regulator.",
  };
}

// A deliberately dense, multi-subsystem board: 60+ parts, many fine SPI/I2C/PWM
// nets, three switching regulators, a 3-phase BLDC bridge, USB, CAN, radio and a
// sensor cluster. Produces rich couplings + fine traces for the "wow" renderings.
function robotSoc(): ExampleDef {
  resetGrid();
  const parts: PartSpec[] = [];
  const P = (ref: string, value: string, sym: string, fp: string, pins: Record<string, string>) =>
    parts.push(part(ref, value, sym, fp, pins));
  let capN = 0;
  const decap = (net: string, val = "100nF") => { capN++; P(`C${100 + capN}`, val, "C", "Capacitor_SMD:C_0402", { "1": net, "2": "GND" }); };

  // ---- main MCU: STM32H7, TQFP-64, fans out the whole system ----
  P("U1", "STM32H743 MCU", "MCU", "Package_QFP:TQFP-64", {
    "1": "3V3", "2": "GND", "3": "USB_DP", "4": "USB_DM", "5": "SCK", "6": "MISO", "7": "MOSI",
    "8": "CS_IMU", "9": "CS_MAG", "10": "CS_ADC", "11": "SDA", "12": "SCL",
    "13": "XTAL1", "14": "XTAL2", "15": "RTC_XIN", "16": "RTC_XOUT",
    "17": "PWM_AH", "18": "PWM_AL", "19": "PWM_BH", "20": "PWM_BL", "21": "PWM_CH", "22": "PWM_CL",
    "23": "ISENSE_A", "24": "ISENSE_B", "25": "ISENSE_C", "26": "CANTX", "27": "CANRX",
    "28": "SWDIO", "29": "SWCLK", "30": "GPIO0", "31": "GPIO1", "32": "GPIO2", "33": "GPIO3",
    "34": "GPIO4", "35": "GPIO5", "36": "GPIO6", "37": "GPIO7", "38": "1V8", "39": "3V3A", "40": "GND",
    "41": "3V3", "42": "GND", "43": "UART_TX", "44": "UART_RX", "45": "I2S_SD", "46": "I2S_CK",
    "47": "LED_R", "48": "LED_G", "49": "3V3", "50": "GND",
  });
  for (let i = 0; i < 6; i++) decap("3V3");
  decap("1V8"); decap("3V3A"); decap("1V8");

  // ---- power tree: 3 synchronous bucks (5V / 3V3 / 1V8) + analog LDO ----
  P("U2", "TPS54560 5V", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", { "1": "SW1", "2": "GND", "3": "5V", "4": "EN", "5": "VBUS", "6": "FB5" });
  P("L1", "3.3uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW1", "2": "5V" });
  P("C1", "22uF", "C", "Capacitor_SMD:C_1206", { "1": "VBUS", "2": "GND" });
  P("C2", "47uF", "C", "Capacitor_SMD:C_1206", { "1": "5V", "2": "GND" });
  P("R1", "100k", "R", "Resistor_SMD:R_0402", { "1": "5V", "2": "FB5" });
  P("R2", "20k", "R", "Resistor_SMD:R_0402", { "1": "FB5", "2": "GND" });

  P("U3", "TPS62912 3V3", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", { "1": "SW2", "2": "GND", "3": "3V3", "4": "EN", "5": "5V", "6": "FB3" });
  P("L2", "2.2uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW2", "2": "3V3" });
  P("C3", "22uF", "C", "Capacitor_SMD:C_0805", { "1": "5V", "2": "GND" });
  P("C4", "22uF", "C", "Capacitor_SMD:C_0805", { "1": "3V3", "2": "GND" });
  P("R3", "100k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "FB3" });
  P("R4", "33k", "R", "Resistor_SMD:R_0402", { "1": "FB3", "2": "GND" });

  P("U4", "TLV62568 1V8", "Regulator", "Package_TO_SOT_SMD:SOT-23-6", { "1": "SW3", "2": "GND", "3": "1V8", "4": "EN", "5": "3V3", "6": "FB1" });
  P("L3", "1.0uH", "L", "Inductor_SMD:L_Power_5x5", { "1": "SW3", "2": "1V8" });
  P("C5", "10uF", "C", "Capacitor_SMD:C_0805", { "1": "1V8", "2": "GND" });
  P("U5", "LP5907 3V3A", "Regulator", "Package_TO_SOT_SMD:SOT-23", { "1": "3V3", "2": "GND", "3": "3V3A" });
  decap("3V3A"); decap("5V"); decap("5V");

  // ---- USB-C + ESD ----
  P("J1", "USB_C", "USB", "Connector_USB:USB_C_Receptacle", { "1": "GND", "2": "VBUS", "4": "USB_DP", "5": "USB_DM", "9": "GND", "10": "GND" });
  P("U6", "TPD4S ESD", "Diode", "Package_TO_SOT_SMD:SOT-23-6", { "1": "USB_DP", "2": "GND", "3": "USB_DM", "4": "USB_DP", "5": "VBUS", "6": "USB_DM" });

  // ---- BLDC 3-phase power stage: gate driver + 6 FETs + shunts ----
  P("U7", "DRV8353 gate", "MotorDriver", "Package_QFP:QFN-48", {
    "1": "VMOT", "2": "GND", "3": "PWM_AH", "4": "PWM_AL", "5": "PWM_BH", "6": "PWM_BL",
    "7": "PWM_CH", "8": "PWM_CL", "9": "GH_A", "10": "GL_A", "11": "GH_B", "12": "GL_B",
    "13": "GH_C", "14": "GL_C", "15": "ISENSE_A", "16": "ISENSE_B", "17": "ISENSE_C",
    "18": "SCK", "19": "MOSI", "20": "MISO", "21": "CS_DRV", "22": "3V3", "23": "GND", "24": "VMOT",
  });
  P("Q1", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GH_A", "2": "VMOT", "3": "MOT_A" });
  P("Q2", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GL_A", "2": "MOT_A", "3": "PGND" });
  P("Q3", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GH_B", "2": "VMOT", "3": "MOT_B" });
  P("Q4", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GL_B", "2": "MOT_B", "3": "PGND" });
  P("Q5", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GH_C", "2": "VMOT", "3": "MOT_C" });
  P("Q6", "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": "GL_C", "2": "MOT_C", "3": "PGND" });
  P("R5", "1m shunt", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": "ISENSE_A" });
  P("R6", "1m shunt", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": "ISENSE_B" });
  P("R7", "1m shunt", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": "ISENSE_C" });
  P("C20", "100uF", "C", "Capacitor_SMD:C_1206", { "1": "VMOT", "2": "PGND" });
  P("C21", "100uF", "C", "Capacitor_SMD:C_1206", { "1": "VMOT", "2": "PGND" });
  P("J2", "MOTOR", "Conn", "Connector:ScrewTerminal_1x3", { "1": "MOT_A", "2": "MOT_B", "3": "MOT_C" });
  P("J5", "VMOT_IN", "Conn", "Connector:ScrewTerminal_1x2", { "1": "VMOT", "2": "PGND" });

  // ---- radio + matching network + antenna ----
  P("U8", "nRF52840", "RF", "Package_QFN:QFN-48", { "1": "3V3", "2": "GND", "3": "RF", "4": "ANT_FEED", "5": "SDA", "6": "SCL", "7": "XTAL1", "8": "XTAL2", "9": "GPIO8", "10": "GPIO9" });
  P("L4", "3.9nH", "L", "Inductor_SMD:L_0805", { "1": "RF", "2": "ANT_FEED" });
  P("C30", "0.5pF", "C", "Capacitor_SMD:C_0402", { "1": "ANT_FEED", "2": "GND" });
  P("ANT1", "2.4GHz chip", "Antenna", "RF_Antenna:Antenna_Chip", { "1": "ANT_FEED" });
  decap("3V3");

  // ---- sensor cluster: IMU (SPI), magnetometer + barometer (I2C), precision ADC ----
  P("U9", "ICM42688 IMU", "IMU", "Package_QFN:QFN-24", { "1": "3V3", "2": "GND", "3": "SCK", "4": "MISO", "5": "MOSI", "6": "CS_IMU", "7": "GPIO10", "8": "3V3" });
  P("U10", "MMC5983 mag", "Sensor", "Package_QFP:QFN-24", { "1": "3V3", "2": "GND", "3": "SDA", "4": "SCL" });
  P("U11", "BMP390 baro", "Sensor", "Package_LGA:LGA-8", { "1": "3V3", "2": "GND", "3": "SDA", "4": "SCL" });
  P("U12", "ADS131 ADC", "ADC", "Package_QFP:QFN-32", { "1": "3V3A", "2": "GND", "3": "SCK", "4": "MISO", "5": "MOSI", "6": "CS_ADC", "7": "ISENSE_A", "8": "ISENSE_B", "9": "ISENSE_C", "10": "3V3A" });
  decap("3V3"); decap("3V3"); decap("3V3A");
  P("R10", "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SDA" });
  P("R11", "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SCL" });

  // ---- CAN transceiver ----
  P("U13", "TCAN332", "Sensor", "Package_SO:SOIC-8", { "1": "CANTX", "2": "GND", "3": "5V", "4": "CANRX", "5": "CANL", "6": "CANH", "7": "5V", "8": "GND" });
  P("J6", "CAN", "Conn", "Connector:PinHeader_1x4", { "1": "CANH", "2": "CANL", "3": "GND", "4": "5V" });

  // ---- clocks ----
  P("Y1", "25MHz", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "XTAL1", "2": "GND", "3": "XTAL2", "4": "GND" });
  P("Y2", "32.768kHz", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "RTC_XIN", "2": "GND", "3": "RTC_XOUT", "4": "GND" });

  // ---- IO / debug headers ----
  P("J3", "SWD", "Conn", "Connector:PinHeader_1x4", { "1": "3V3", "2": "SWDIO", "3": "SWCLK", "4": "GND" });
  P("J4", "GPIO", "Conn", "Connector:PinHeader_1x6", { "1": "GPIO0", "2": "GPIO1", "3": "GPIO2", "4": "GPIO3", "5": "GPIO4", "6": "GND" });
  P("J7", "UART", "Conn", "Connector:PinHeader_1x4", { "1": "UART_TX", "2": "UART_RX", "3": "3V3", "4": "GND" });
  P("D1", "status R", "D", "LED_SMD:LED_0603", { "1": "LED_R", "2": "GND" });
  P("D2", "status G", "D", "LED_SMD:LED_0603", { "1": "LED_G", "2": "GND" });
  P("R12", "1k", "R", "Resistor_SMD:R_0402", { "1": "GPIO6", "2": "LED_R" });
  P("R13", "1k", "R", "Resistor_SMD:R_0402", { "1": "GPIO7", "2": "LED_G" });
  P("TP1", "VMOT", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "VMOT" });
  P("TP2", "GND", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "GND" });

  return {
    name: "robot_soc", title: "Robotics control SoC (BLDC + radio + sensors)",
    board: { width: 96, height: 70, diffPairs: [{ p: "USB_DP", n: "USB_DM", spacing: 0.18 }, { p: "CANH", n: "CANL", spacing: 0.2 }] },
    parts,
    description: "STM32H7 driving a 3-phase BLDC power stage (DRV8353 + 6 FETs + shunts), an nRF52840 radio with matching network, a 3-buck power tree, USB-C, CAN, and a 4-chip sensor cluster. Dozens of fine SPI/I2C/PWM nets, three switching nodes, and high-current motor phases must coexist without coupling.",
  };
}

// A very large, dense robotics MAINBOARD: ~200 components across a SoC + coprocessor,
// dual DDR, a 6-rail power tree, FOUR 3-phase BLDC channels, an 8-chip sensor bus,
// two radios, Ethernet/CAN/RS485/USB, clocks, LED bank, IO headers and ~70 decaps.
// Hundreds of fine SPI/I2C/DQ/PWM nets + high-current motor phases = the complexity hero.
function mainboard(): ExampleDef {
  resetGrid();
  const parts: PartSpec[] = [];
  let refSeq: Record<string, number> = {};
  const P = (ref: string, value: string, sym: string, fp: string, pins: Record<string, string>) =>
    parts.push(part(ref, value, sym, fp, pins));
  const decap = (net: string, val = "100nF") => { refSeq.C = (refSeq.C || 100) + 1; P(`C${refSeq.C}`, val, "C", "Capacitor_SMD:C_0402", { "1": net, "2": "GND" }); };

  // ---- compute: SoC + coprocessor + FPGA ----
  P("U1", "AM62 SoC", "MCU", "Package_QFP:TQFP-64", {
    "1": "0V8", "2": "GND", "3": "1V8", "4": "3V3", "5": "DQ0", "6": "DQ1", "7": "DQ2", "8": "DQ3",
    "9": "DQ4", "10": "DQ5", "11": "DQ6", "12": "DQ7", "13": "DQ8", "14": "DQ9", "15": "DQ10", "16": "DQ11",
    "17": "DQ12", "18": "DQ13", "19": "DQ14", "20": "DQ15", "21": "DCLK", "22": "DCLKN", "23": "SCK", "24": "MOSI",
    "25": "MISO", "26": "SDA", "27": "SCL", "28": "USB_DP", "29": "USB_DM", "30": "ETH_TXP", "31": "ETH_TXN", "32": "ETH_RXP",
    "33": "ETH_RXN", "34": "CANTX", "35": "CANRX", "36": "UART0_TX", "37": "UART0_RX", "38": "XTAL1", "39": "XTAL2", "40": "RGMII_TX0",
    "41": "RGMII_TX1", "42": "RGMII_RX0", "43": "RGMII_RX1", "44": "PCIE_TXP", "45": "PCIE_TXN", "46": "SWDIO", "47": "SWCLK", "48": "GND",
    "49": "FAB0", "50": "FAB1", "51": "FAB2", "52": "FAB3", "53": "0V8", "54": "GND", "55": "1V8", "56": "3V3",
    "57": "CS_FLASH", "58": "CS_FPGA", "59": "GPIO0", "60": "GPIO1", "61": "GPIO2", "62": "GPIO3", "63": "GPIO4", "64": "GND",
  });
  for (let i = 0; i < 10; i++) decap("0V8");
  for (let i = 0; i < 6; i++) decap("1V8");

  P("U2", "RP2040 coproc", "MCU", "Package_QFP:QFN-56", {
    "1": "3V3", "2": "GND", "3": "SCK", "4": "MOSI", "5": "MISO", "6": "SDA", "7": "SCL", "8": "UART1_TX",
    "9": "UART1_RX", "10": "FAB0", "11": "FAB1", "12": "FAB2", "13": "FAB3", "14": "GPIO5", "15": "GPIO6", "16": "GPIO7",
    "17": "PWM0", "18": "PWM1", "19": "PWM2", "20": "PWM3", "21": "ADC0", "22": "ADC1", "23": "ADC2", "24": "ADC3",
  });
  for (let i = 0; i < 4; i++) decap("3V3");
  P("U3", "ICE40 FPGA", "MCU", "Package_QFP:TQFP-64", {
    "1": "1V2", "2": "GND", "3": "3V3", "4": "CS_FPGA", "5": "SCK", "6": "MOSI", "7": "MISO", "8": "FAB0",
    "9": "FAB1", "10": "FAB2", "11": "FAB3", "12": "DQ0", "13": "DQ1", "14": "DQ2", "15": "DQ3", "16": "DCLK",
  });
  for (let i = 0; i < 5; i++) decap("1V2");
  P("U4", "W25Q flash", "Sensor", "Package_SO:SOIC-8", { "1": "CS_FLASH", "2": "MISO", "3": "3V3", "4": "GND", "5": "MOSI", "6": "SCK", "7": "3V3", "8": "3V3" });

  // ---- dual DDR memory on a shared 16-bit DQ bus ----
  for (const d of ["U5", "U6"]) {
    P(d, "LPDDR4", "MCU", "Package_QFP:QFN-56", {
      "1": "1V2", "2": "GND", "3": "DQ0", "4": "DQ1", "5": "DQ2", "6": "DQ3", "7": "DQ4", "8": "DQ5",
      "9": "DQ6", "10": "DQ7", "11": "DQ8", "12": "DQ9", "13": "DQ10", "14": "DQ11", "15": "DQ12", "16": "DQ13",
      "17": "DQ14", "18": "DQ15", "19": "DCLK", "20": "DCLKN", "21": "1V2", "22": "GND", "23": "1V2", "24": "GND",
    });
    decap("1V2"); decap("1V2"); decap("1V2");
  }

  // ---- power tree: six switching rails (0V8/1V2/1V8/3V3/5V/12V->5V) ----
  const rails: [string, string, string, string][] = [
    ["U10", "TPS5450 5V", "VIN12", "5V"], ["U11", "TPS62 3V3", "5V", "3V3"], ["U12", "TPS62 1V8", "3V3", "1V8"],
    ["U13", "TPS62 1V2", "3V3", "1V2"], ["U14", "TPS54 0V8", "5V", "0V8"], ["U15", "LP5907 3V3A", "3V3", "3V3A"],
  ];
  rails.forEach(([ref, val, vin, vout], i) => {
    const sw = `SW${i + 1}`, fb = `FB${i + 1}`;
    if (val.includes("LP5907")) { P(ref, val, "Regulator", "Package_TO_SOT_SMD:SOT-23", { "1": vin, "2": "GND", "3": vout }); decap(vout); return; }
    P(ref, val, "Regulator", "Package_TO_SOT_SMD:SOT-23-6", { "1": sw, "2": "GND", "3": vout, "4": "EN", "5": vin, "6": fb });
    P(`L${i + 1}`, "2.2uH", "L", "Inductor_SMD:L_Power_5x5", { "1": sw, "2": vout });
    P(`C${200 + i * 2}`, "22uF", "C", "Capacitor_SMD:C_1206", { "1": vin, "2": "GND" });
    P(`C${201 + i * 2}`, "47uF", "C", "Capacitor_SMD:C_1206", { "1": vout, "2": "GND" });
    refSeq.R = (refSeq.R || 0) + 1; P(`R${refSeq.R}`, "100k", "R", "Resistor_SMD:R_0402", { "1": vout, "2": fb });
    refSeq.R += 1; P(`R${refSeq.R}`, "20k", "R", "Resistor_SMD:R_0402", { "1": fb, "2": "GND" });
  });

  // ---- FOUR 3-phase BLDC channels ----
  for (let ch = 0; ch < 4; ch++) {
    const g = `U${20 + ch}`;
    const ph = (p: string) => `M${ch}_${p}`;
    P(g, `DRV8353 ch${ch}`, "MotorDriver", "Package_QFP:QFN-48", {
      "1": "VMOT", "2": "PGND", "3": `PWM${ch}_AH`, "4": `PWM${ch}_AL`, "5": `PWM${ch}_BH`, "6": `PWM${ch}_BL`,
      "7": `PWM${ch}_CH`, "8": `PWM${ch}_CL`, "9": `GH${ch}A`, "10": `GL${ch}A`, "11": `GH${ch}B`, "12": `GL${ch}B`,
      "13": `GH${ch}C`, "14": `GL${ch}C`, "15": `IS${ch}A`, "16": `IS${ch}B`, "17": `IS${ch}C`, "18": "SCK",
      "19": "MOSI", "20": "MISO", "21": `CS_DRV${ch}`, "22": "3V3", "23": "PGND", "24": "VMOT",
    });
    const fets: [string, string, string][] = [
      [`GH${ch}A`, "VMOT", ph("A")], [`GL${ch}A`, ph("A"), "PGND"], [`GH${ch}B`, "VMOT", ph("B")],
      [`GL${ch}B`, ph("B"), "PGND"], [`GH${ch}C`, "VMOT", ph("C")], [`GL${ch}C`, ph("C"), "PGND"],
    ];
    fets.forEach(([gate, d1, d2], k) => P(`Q${ch * 6 + k + 1}`, "CSD18540", "Q", "Package_TO_SOT_SMD:SOT23", { "1": gate, "2": d1, "3": d2 }));
    refSeq.R = (refSeq.R || 0) + 1; P(`R${refSeq.R}`, "1m", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": `IS${ch}A` });
    refSeq.R += 1; P(`R${refSeq.R}`, "1m", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": `IS${ch}B` });
    refSeq.R += 1; P(`R${refSeq.R}`, "1m", "R", "Resistor_SMD:R_0805", { "1": "PGND", "2": `IS${ch}C` });
    P(`C${220 + ch * 2}`, "100uF", "C", "Capacitor_SMD:C_1206", { "1": "VMOT", "2": "PGND" });
    P(`C${221 + ch * 2}`, "100uF", "C", "Capacitor_SMD:C_1206", { "1": "VMOT", "2": "PGND" });
    P(`J${10 + ch}`, `MOT${ch}`, "Conn", "Connector:ScrewTerminal_1x3", { "1": ph("A"), "2": ph("B"), "3": ph("C") });
  }
  P("J20", "VMOT_IN", "Conn", "Connector:ScrewTerminal_1x2", { "1": "VMOT", "2": "PGND" });
  P("J21", "12V_IN", "Conn", "Connector:ScrewTerminal_1x2", { "1": "VIN12", "2": "GND" });

  // ---- 8-chip sensor bus (SPI + I2C, individual CS) ----
  const sensors: [string, string, string][] = [
    ["U40", "ICM42688 imu", "spi"], ["U41", "BMI270 imu", "spi"], ["U42", "MMC5983 mag", "i2c"], ["U43", "BMP390 baro", "i2c"],
    ["U44", "SHT45 rh", "i2c"], ["U45", "VL53 tof", "i2c"], ["U46", "ADS131 adc", "spi"], ["U47", "MAX31855 tc", "spi"],
  ];
  sensors.forEach(([ref, val, bus], i) => {
    if (bus === "spi") P(ref, val, "Sensor", "Package_QFN:QFN-24", { "1": "3V3A", "2": "GND", "3": "SCK", "4": "MISO", "5": "MOSI", "6": `CS_S${i}`, "7": `GPIO${8 + i}` });
    else P(ref, val, "Sensor", "Package_LGA:LGA-8", { "1": "3V3A", "2": "GND", "3": "SDA", "4": "SCL" });
    decap("3V3A");
  });
  refSeq.R = (refSeq.R || 0) + 1; P(`R${refSeq.R}`, "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SDA" });
  refSeq.R += 1; P(`R${refSeq.R}`, "4.7k", "R", "Resistor_SMD:R_0402", { "1": "3V3", "2": "SCL" });

  // ---- two radios + matching + antennas ----
  for (let r = 0; r < 2; r++) {
    const ref = `U${50 + r}`, rf = `RF${r}`, feed = `ANT${r}`;
    P(ref, r === 0 ? "nRF52840" : "SX1262 LoRa", "RF", "Package_QFN:QFN-48", { "1": "3V3", "2": "GND", "3": rf, "4": feed, "5": "SCK", "6": "MISO", "7": "MOSI", "8": `CS_RF${r}`, "9": "XTAL1", "10": "XTAL2" });
    P(`L${20 + r}`, "3.9nH", "L", "Inductor_SMD:L_0805", { "1": rf, "2": feed });
    P(`C${240 + r}`, "0.5pF", "C", "Capacitor_SMD:C_0402", { "1": feed, "2": "GND" });
    P(`ANT${r}`, "2.4G chip", "Antenna", "RF_Antenna:Antenna_Chip", { "1": feed });
    decap("3V3");
  }

  // ---- comms: Ethernet PHY + RJ45, CAN, RS485, USB ----
  P("U60", "DP83825 PHY", "MCU", "Package_QFP:QFN-32", { "1": "3V3", "2": "GND", "3": "RGMII_TX0", "4": "RGMII_TX1", "5": "RGMII_RX0", "6": "RGMII_RX1", "7": "ETH_TXP", "8": "ETH_TXN", "9": "ETH_RXP", "10": "ETH_RXN", "11": "MDC", "12": "MDIO", "13": "XTAL1", "14": "1V2", "15": "GND", "16": "3V3" });
  decap("3V3"); decap("1V2");
  P("J30", "RJ45", "Conn", "Connector:PinHeader_1x6", { "1": "ETH_TXP", "2": "ETH_TXN", "3": "ETH_RXP", "4": "ETH_RXN", "5": "3V3", "6": "GND" });
  P("U61", "TCAN332", "Sensor", "Package_SO:SOIC-8", { "1": "CANTX", "2": "GND", "3": "3V3", "4": "CANRX", "5": "CANL", "6": "CANH", "7": "3V3", "8": "GND" });
  P("J31", "CAN", "Conn", "Connector:PinHeader_1x4", { "1": "CANH", "2": "CANL", "3": "GND", "4": "3V3" });
  P("U62", "THVD1500 485", "Sensor", "Package_SO:SOIC-8", { "1": "UART1_TX", "2": "GND", "3": "3V3", "4": "UART1_RX", "5": "RS_A", "6": "RS_B", "7": "3V3", "8": "GND" });
  P("J32", "RS485", "Conn", "Connector:PinHeader_1x4", { "1": "RS_A", "2": "RS_B", "3": "GND", "4": "3V3" });
  P("J33", "USB_C", "USB", "Connector_USB:USB_C_Receptacle", { "1": "GND", "2": "VIN12", "4": "USB_DP", "5": "USB_DM", "9": "GND" });
  P("U63", "TPD4S ESD", "Diode", "Package_TO_SOT_SMD:SOT-23-6", { "1": "USB_DP", "2": "GND", "3": "USB_DM", "4": "USB_DP", "5": "5V", "6": "USB_DM" });

  // ---- clocks ----
  P("Y1", "25MHz", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "XTAL1", "2": "GND", "3": "XTAL2", "4": "GND" });
  P("Y2", "32.768k", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "RTC_XIN", "2": "GND", "3": "RTC_XOUT", "4": "GND" });
  P("Y3", "50MHz eth", "Crystal", "Crystal:Crystal_SMD_3225", { "1": "ETH_XI", "2": "GND", "3": "ETH_XO", "4": "GND" });

  // ---- LED status bank ----
  for (let i = 0; i < 8; i++) {
    P(`D${i + 1}`, "led", "D", "LED_SMD:LED_0603", { "1": `LED${i}`, "2": "GND" });
    refSeq.R = (refSeq.R || 0) + 1; P(`R${refSeq.R}`, "1k", "R", "Resistor_SMD:R_0402", { "1": `GPIO${i}`, "2": `LED${i}` });
  }

  // ---- IO headers + test points ----
  P("J40", "GPIO-A", "Conn", "Connector:PinHeader_1x6", { "1": "GPIO0", "2": "GPIO1", "3": "GPIO2", "4": "GPIO3", "5": "GPIO4", "6": "GND" });
  P("J41", "SWD", "Conn", "Connector:PinHeader_1x4", { "1": "3V3", "2": "SWDIO", "3": "SWCLK", "4": "GND" });
  P("J42", "ADC", "Conn", "Connector:PinHeader_1x4", { "1": "ADC0", "2": "ADC1", "3": "ADC2", "4": "ADC3" });
  P("TP1", "VMOT", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "VMOT" });
  P("TP2", "3V3", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "3V3" });
  P("TP3", "GND", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "GND" });
  P("TP4", "0V8", "TestPoint", "TestPoint:TestPoint_Pad_D1.5mm", { "1": "0V8" });

  return {
    name: "mainboard", title: "Autonomy mainboard (SoC + 4× BLDC + radios + Ethernet)",
    board: { width: 132, height: 100, diffPairs: [{ p: "USB_DP", n: "USB_DM", spacing: 0.18 }, { p: "ETH_TXP", n: "ETH_TXN", spacing: 0.2 }, { p: "ETH_RXP", n: "ETH_RXN", spacing: 0.2 }, { p: "CANH", n: "CANL", spacing: 0.2 }] },
    parts,
    description: "A ~200-part autonomy mainboard: AM62 SoC + RP2040 + ICE40 FPGA, dual LPDDR4 on a shared 16-bit bus, a six-rail switching power tree, FOUR 3-phase BLDC channels (24 FETs), an 8-chip sensor bus, two radios, Ethernet/CAN/RS485/USB, three crystals and ~70 decaps. Hundreds of fine SPI/I2C/DQ/PWM nets and high-current motor phases must coexist.",
  };
}

function writeExample(def: ExampleDef) {
  const dir = path.join(EX_DIR, def.name);
  fs.mkdirSync(dir, { recursive: true });
  const spec: SchSpec = { name: def.name, title: def.title, parts: def.parts };
  fs.writeFileSync(path.join(dir, `${def.name}.kicad_sch`), genSchematic(spec));
  const cfg = {
    name: def.name,
    title: def.title,
    description: def.description,
    board: { width: def.board.width, height: def.board.height, diffPairs: def.board.diffPairs || [] },
  };
  fs.writeFileSync(path.join(dir, "layla.json"), JSON.stringify(cfg, null, 2));
  console.log(`  wrote examples/${def.name}/${def.name}.kicad_sch  (${def.parts.length} parts)`);
}

function main() {
  fs.mkdirSync(EX_DIR, { recursive: true });
  console.log("Generating example schematics...");
  [buckImu(), motorDriver(), rfSensor(), robotSoc(), mainboard()].forEach(writeExample);
  // index
  const index = ["mainboard", "robot_soc", "buck_imu", "motor_driver", "rf_sensor"].map((n) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(EX_DIR, n, "layla.json"), "utf8"));
    return { name: n, title: cfg.title, description: cfg.description, schematic: `${n}/${n}.kicad_sch`, config: `${n}/layla.json` };
  });
  fs.writeFileSync(path.join(EX_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log("Done. examples/index.json written.");
}

main();
