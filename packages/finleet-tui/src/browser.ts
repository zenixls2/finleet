import { execFile } from "node:child_process";

export interface BrowserLaunchCommand {
  command: string;
  args: readonly string[];
}

/** Build a shell-free platform browser command so URL metacharacters remain data. */
export const browserLaunchCommand = (url: string, platform: NodeJS.Platform = process.platform): BrowserLaunchCommand => platform === "darwin"
  ? { command: "open", args: [url] }
  : platform === "win32"
    ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : { command: "xdg-open", args: [url] };

export const openBrowserUrl = (url: string, platform: NodeJS.Platform = process.platform): Promise<void> => new Promise((resolve, reject) => {
  const launch = browserLaunchCommand(url, platform);
  execFile(launch.command, [...launch.args], { windowsHide: true }, (error) => error === null ? resolve() : reject(error));
});
