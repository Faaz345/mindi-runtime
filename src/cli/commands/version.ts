/** `mindi version` — shows version information. */

import { VERSION } from "../../index.js";
import { colors, header } from "../format.js";

export function versionCommand(): void {
  header("MINDI Runtime");
  process.stdout.write(`  ${colors.bold("Version")}     ${colors.cyan(VERSION)}\n`);
  process.stdout.write(`  ${colors.bold("Node")}        ${process.version}\n`);
  process.stdout.write(`  ${colors.bold("Platform")}    ${process.platform} ${process.arch}\n`);
  process.stdout.write(`  ${colors.bold("PID")}         ${process.pid}\n`);
  process.stdout.write("\n");
}
