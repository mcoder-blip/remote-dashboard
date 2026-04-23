const rcedit = require('rcedit');
const path = require('path');

const exePath = path.resolve(__dirname, 'winxagent.exe');
const iconPath = path.resolve(__dirname, 'logo.ico');

async function apply() {
  try {
    console.log(`Targeting: ${exePath}`);
    await rcedit(exePath, {
      icon: iconPath,
      'version-string': {
        FileDescription: 'WinX Connectivity Agent',
        ProductName: 'WinX Agent',
        CompanyName: 'WinX Systems',
        LegalCopyright: 'Copyright (C) 2024 WinX Systems'
      }
    });
    console.log('Successfully applied neutral metadata to winxagent.exe');
  } catch (err) {
    console.error('Failed to apply metadata:', err);
  }
}

apply();