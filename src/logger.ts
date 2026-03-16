type Level = "info" | "warn" | "error";

function log(level: Level, message: string) {
  const ts = new Date().toISOString();
  const prefix = { info: "ℹ️ ", warn: "⚠️ ", error: "❌" }[level];
  const line = `[${ts}] ${prefix}  ${message}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
