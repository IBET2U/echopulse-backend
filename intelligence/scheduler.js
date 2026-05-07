const cron = require("node-cron");

const { runChampionScan } = require("./championMonitor");
const { runNewsMonitor } = require("./newsMonitor");

async function runScanSafely(trigger) {
  const startedAt = new Date().toISOString();
  console.log(`[EchoPulse] Champion scan started (${trigger}) at ${startedAt}`);

  try {
    await runChampionScan();
    const completedAt = new Date().toISOString();
    console.log(
      `[EchoPulse] Champion scan completed (${trigger}) at ${completedAt}`,
    );
  } catch (err) {
    console.error(
      `[EchoPulse] Champion scan failed (${trigger}):`,
      err?.stack || err?.message || err,
    );
  }
}

async function runNewsMonitorSafely(trigger) {
  const startedAt = new Date().toISOString();
  console.log(`[EchoPulse] News monitor started (${trigger}) at ${startedAt}`);

  try {
    await runNewsMonitor();
    const completedAt = new Date().toISOString();
    console.log(
      `[EchoPulse] News monitor completed (${trigger}) at ${completedAt}`,
    );
  } catch (err) {
    console.error(
      `[EchoPulse] News monitor failed (${trigger}):`,
      err?.stack || err?.message || err,
    );
  }
}

function startScheduler() {
  // Daily at 07:00 (server local time)
  cron.schedule("0 7 * * *", () => {
    void runScanSafely("cron:daily-7am");
  });

  // Daily at 08:00 (server local time)
  cron.schedule("0 8 * * *", () => {
    void runNewsMonitorSafely("cron:daily-8am");
  });

  if (process.env.NODE_ENV === "development") {
    void runScanSafely("startup:development");
    void runNewsMonitorSafely("startup:development");
  }
}

module.exports = {
  startScheduler,
};
