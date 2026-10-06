export const SHELL_HOST_CONTRACT = {
  nativeHost: 'com.deepseek_pp.shell',
  packageName: '@tflystar/deepseek-pp-shell-host',
  nodeEngine: '>=18.17',
  firefoxExtensionId: 'deepseek-pp@zhu1090093659.github',
  browsers: ['chrome', 'chromium', 'edge', 'firefox'],
  commands: ['install', 'status', 'uninstall'],
  initializedServer: { name: 'deepseek-pp-shell' },
  instructions: 'General-purpose shell execution host. Use shell_exec for local commands and python_exec only for short computation or validation snippets.',
} as const;

export const INSTALLER_LOCATION_FIXTURES = [
  {
    name: 'macOS Chrome',
    input: { os: 'darwin', browser: 'chrome', home: '/Users/contract', localAppData: undefined },
    output: {
      appDataRoot: '/Users/contract/Library/Application Support/DeepSeek++',
      hostInstallDir: '/Users/contract/Library/Application Support/DeepSeek++/NativeHost',
      manifestDir: '/Users/contract/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      manifestPath: '/Users/contract/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'macOS Firefox',
    input: { os: 'darwin', browser: 'firefox', home: '/Users/contract', localAppData: undefined },
    output: {
      appDataRoot: '/Users/contract/Library/Application Support/DeepSeek++',
      hostInstallDir: '/Users/contract/Library/Application Support/DeepSeek++/NativeHost',
      manifestDir: '/Users/contract/Library/Application Support/Mozilla/NativeMessagingHosts',
      manifestPath: '/Users/contract/Library/Application Support/Mozilla/NativeMessagingHosts/com.deepseek_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Linux Edge',
    input: { os: 'linux', browser: 'edge', home: '/home/contract', localAppData: undefined },
    output: {
      appDataRoot: '/home/contract/.local/share/deepseek-pp',
      hostInstallDir: '/home/contract/.local/share/deepseek-pp/native-host',
      manifestDir: '/home/contract/.config/microsoft-edge/NativeMessagingHosts',
      manifestPath: '/home/contract/.config/microsoft-edge/NativeMessagingHosts/com.deepseek_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Linux Chromium',
    input: { os: 'linux', browser: 'chromium', home: '/home/contract', localAppData: undefined },
    output: {
      appDataRoot: '/home/contract/.local/share/deepseek-pp',
      hostInstallDir: '/home/contract/.local/share/deepseek-pp/native-host',
      manifestDir: '/home/contract/.config/chromium/NativeMessagingHosts',
      manifestPath: '/home/contract/.config/chromium/NativeMessagingHosts/com.deepseek_pp.shell.json',
      registryKey: null,
    },
  },
  {
    name: 'Windows Chrome',
    input: {
      os: 'win32',
      browser: 'chrome',
      home: 'C:\\Users\\contract',
      localAppData: 'C:\\Users\\contract\\AppData\\Local',
    },
    output: {
      appDataRoot: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++',
      hostInstallDir: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeHost',
      manifestDir: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts',
      manifestPath: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts\\com.deepseek_pp.shell.chrome.json',
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.deepseek_pp.shell',
    },
  },
  {
    name: 'Windows Firefox',
    input: {
      os: 'win32',
      browser: 'firefox',
      home: 'C:\\Users\\contract',
      localAppData: 'C:\\Users\\contract\\AppData\\Local',
    },
    output: {
      appDataRoot: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++',
      hostInstallDir: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeHost',
      manifestDir: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts',
      manifestPath: 'C:\\Users\\contract\\AppData\\Local\\DeepSeek++\\NativeMessagingHosts\\com.deepseek_pp.shell.firefox.json',
      registryKey: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.deepseek_pp.shell',
    },
  },
] as const;

export const INSTALLER_CURRENT_GAPS = [
  {
    name: 'OfficeCLI installation occurs after host files and manifest are committed',
    status: 'deferred',
    owner: 'deferred:installer-transactionality',
    target: 'explicit-install-journal-or-partial-state',
  },
  {
    name: 'missing checksum metadata permits installation to continue',
    status: 'deferred',
    owner: 'deferred:installer-integrity-policy',
    target: 'fail-closed-checksum-policy',
  },
  {
    name: 'Windows registry failure is warning-only and status does not verify the registered value',
    status: 'deferred',
    owner: 'deferred:installer-registry-health',
    target: 'observable-registry-health',
  },
] as const;
