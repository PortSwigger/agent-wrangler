const truthy = (v) => v != null && !['', '0', 'false', 'no'].includes(String(v).toLowerCase());

export const INSTALLS_OFF_MESSAGE = 'Extension installs are off on this deck (it was started with --extension-installs-off, env AW_EXTENSION_INSTALLS_OFF), so extensions cannot be installed, updated or uninstalled here. Turning them on or off and changing their settings still work.';

const STARTUP = truthy(process.env.AW_EXTENSION_INSTALLS_OFF);

let source = () => STARTUP;

export function extensionInstallsOff() {
  return source();
}

export function assertExtensionInstallsOn() {
  if (source()) throw new Error(INSTALLS_OFF_MESSAGE);
}

export function setExtensionInstallsOffForTest(fn) {
  source = fn || (() => STARTUP);
}
