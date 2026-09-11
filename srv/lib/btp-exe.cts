const path = require("path");
const os = require("os");
const fs = require("fs");

/**
 * Locates the `btp` CLI executable. It's rarely on PATH (winget user-scope installs aren't),
 * so this also checks the standard per-user winget install location before giving up — an
 * explicit BTP_CLI_PATH env var always wins, for anyone whose setup differs.
 */
function resolveBtpExe(): string {
  if (process.env.BTP_CLI_PATH) return process.env.BTP_CLI_PATH;

  const isWin = process.platform === "win32";
  const exeName = isWin ? "btp.exe" : "btp";

  const wingetCandidate = path.join(
    os.homedir(),
    "AppData",
    "Local",
    "Microsoft",
    "WinGet",
    "Packages",
    "SAP.btp_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "windows-amd64",
    "btp.exe"
  );
  if (isWin && fs.existsSync(wingetCandidate)) return wingetCandidate;

  // Otherwise assume it's resolvable via PATH (e.g. Homebrew/apt installs on macOS/Linux, or a
  // manually PATH-added Windows install) and let spawn()'s own PATH lookup find it.
  return exeName;
}

const BTP_EXE = resolveBtpExe();

module.exports = { resolveBtpExe, BTP_EXE };
