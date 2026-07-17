import mainboard from "../public/data/mainboard.json";
import robot from "../public/data/robot_soc.json";
import buck from "../public/data/buck_imu.json";
import motor from "../public/data/motor_driver.json";
import rf from "../public/data/rf_sensor.json";
import summary from "../public/data/summary.json";

export type Board = typeof buck;
export type GraphNode = Board["graph"]["nodes"][number];
export type GraphEdge = Board["graph"]["edges"][number];
export type EmiLevel = Board["emi"]["levels"][number];
export type HistRec = Board["history"][number];

export const MAIN = mainboard as Board;
export const ROBOT = robot as Board;
export const BUCK = buck as Board;
export const MOTOR = motor as Board;
export const RF = rf as Board;
export const SUMMARY = summary as { boards: { name: string; title: string; initial: number; final: number; pct: number; substrate: number }[] };

// real bench numbers captured from `node dist/cli.js bench` (filled for robot_soc below)
export const BENCH = [
  { board: "mainboard", anneal: 90530.5, osc: 19613.7, delta: -78, substrate: "v2" },
  { board: "robot_soc", anneal: 11236.9, osc: 4722.9, delta: -58, substrate: "v1" },
  { board: "buck_imu", anneal: 615.2, osc: 385.0, delta: -37, substrate: "v3" },
  { board: "motor_driver", anneal: 526.9, osc: 414.0, delta: -21, substrate: "v3" },
  { board: "rf_sensor", anneal: 433.4, osc: 131.4, delta: -70, substrate: "v3" },
];
