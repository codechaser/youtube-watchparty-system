import { spawn } from "node:child_process";

const windows = process.platform === "win32";
const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const run = (script) =>
  spawn(command, windows ? ["/d", "/s", "/c", `npm run ${script}`] : ["run", script], {
    stdio: "inherit",
  });
const children = [
  run("dev:server"),
  run("dev:client"),
];

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Could not start a development process:", error.message);
    stopAll();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (code && code !== 0) process.exitCode = code;
    stopAll();
  });
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
