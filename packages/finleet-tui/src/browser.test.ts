import assert from "node:assert/strict";
import test from "node:test";
import { browserLaunchCommand } from "./browser.js";

test("browser launch commands never route URLs through a command shell", () => {
  const url = "https://example.test/a&whoami";
  assert.deepEqual(browserLaunchCommand(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserLaunchCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserLaunchCommand(url, "win32"), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
});
