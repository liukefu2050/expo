#!/usr/bin/env node
// Copyright 2015-present 650 Industries. All rights reserved.
'use strict';

require('instapromise');

import _ from 'lodash';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import spawnAsync from '@exponent/spawn-async';
import JsonFile from '@exponent/json-file';
import {
  ExponentTools,
  IosPodsTools,
  UrlUtils,
} from 'xdl';
let {
  modifyIOSPropertyListAsync,
  cleanIOSPropertyListBackupAsync,
} = ExponentTools;
let {
  renderExponentViewPodspecAsync,
  renderPodfileAsync,
} = IosPodsTools;

const ProjectVersions = require('./project-versions');

const LOCALHOST = '127.0.0.1';
const EXPONENT_DIR = path.join(__dirname, '..');

const macrosFuncs = {
  BUILD_MACHINE_IP_ADDRESS: async () => {
    if (process.env.SHELL_APP_BUILDER) {
      return '';
    }

    let interfaces = os.networkInterfaces();
    let enInterfaceNames = Object.keys(interfaces)
      .filter(name => /^en\d$/.test(name));
    let enAddressData = interfaces[enInterfaceNames[0]];
    if (!enAddressData) {
      return LOCALHOST;
    }

    let ipv4Addresses = enAddressData
      .filter(data => data.family === 'IPv4')
      .map(data => data.address);
    if (ipv4Addresses[0]) {
      return ipv4Addresses[0];
    }

    if (enAddressData[0] && enAddressData[0].address) {
      return enAddressData[0].address;
    }

    return LOCALHOST;
  },

  BUILD_MACHINE_LOCAL_HOSTNAME: async () => {
    if (process.env.SHELL_APP_BUILDER) {
      return '';
    }

    try {
      let result = await spawnAsync('scutil', ['--get', 'LocalHostName']);
      return `${result.stdout.trim()}.local`;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(e.stack);
      }
      return os.hostname();
    }
  },

  BUILD_MACHINE_KERNEL_MANIFEST: async () => {
    if (process.env.SHELL_APP_BUILDER) {
      return '';
    }

    try {
      let url = await UrlUtils.constructManifestUrlAsync(
        path.join(__dirname, '..', 'js'),
        { urlType: 'http', hostType: 'tunnel' }
      );
      let manifest = await ExponentTools.getManifestAsync(url, {});
      let manifestJson = JSON.stringify(manifest);
      return manifestJson;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(e.stack);
      }
      return '';
    }
  },

  TEMPORARY_SDK_VERSION: async () => {
    let versions = await ProjectVersions.getProjectVersionsAsync();
    return versions.sdkVersion;
  },

  INITIAL_URL: async () => {
    return null;
  },
};

async function generateSourceAsync(filename, platform) {
  let macros = await generateMacrosAsync();
  let source;
  if (platform === 'ios') {
    source = _.map(macros, (value, name) =>
      `#define ${name} ${formatObjCLiteral(value)}`
    ).join('\n');
  } else if (platform === 'android') {
    let definitions = _.map(macros, (value, name) =>
      `  public static final ${formatJavaType(value)} ${name} = ${formatJavaLiteral(value)};`
    );
    source = `
package host.exp.exponent.generated;

public class ExponentBuildConstants {
${definitions.join('\n')}
}`;
  } else {
    throw new Error(`Cannot generate source for unknown platform ${platform}`);
  }

  return `
// Copyright 2016-present 650 Industries. All rights reserved.
// ${'@'}generated by tools-public/generate-dynamic-macros.js

${source.trim()}
`.trim() + '\n';
}

function formatObjCLiteral(value) {
  if (value == null) {
    return 'nil';
  } else if (typeof value === 'string') {
    value = value.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
    return `@"${value}"`;
  } else if (typeof value === 'number') {
    return value;
  }
  throw new Error(`Unsupported literal value: ${value}`);
}

function formatJavaType(value) {
  if (value == null) {
    return 'String';
  } else if (typeof value === 'string') {
    return 'String';
  } else if (typeof value === 'number') {
    return 'int';
  }
  throw new Error(`Unsupported literal value: ${value}`);
}

function formatJavaLiteral(value) {
  if (value == null) {
    return 'null';
  } else if (typeof value === 'string') {
    return `"${value}"`;
  } else if (typeof value === 'number') {
    return value;
  }
  throw new Error(`Unsupported literal value: ${value}`);
}

async function generateMacrosAsync() {
  let names = [];
  let promises = [];
  _.forEach(macrosFuncs, (func, name) => {
    names.push(name);
    promises.push(func());
  });
  let values = await Promise.all(promises);

  let macros = {};
  for (let entry of names.entries()) {
    let ii = entry[0];
    let name = entry[1];
    macros[name] = values[ii];
  }
  return macros;
}

async function readExistingSourceAsync(filepath) {
  try {
    return await fs.promise.readFile(filepath, 'utf8');
  } catch (e) {
    return null;
  }
}

async function copyTemplateFileAsync(source, dest, templateSubstitutions) {
  let promises = await Promise.all([readExistingSourceAsync(source), readExistingSourceAsync(dest)]);
  let currentSourceFile = promises[0];
  let currentDestFile = promises[1];

  _.map(templateSubstitutions, (value, textToReplace) => {
    currentSourceFile = currentSourceFile.replace(new RegExp(`\\\$\\\{${textToReplace}\\\}`, 'g'), value);
  });

  if (currentSourceFile !== currentDestFile) {
    await fs.promise.writeFile(dest, currentSourceFile, 'utf8');
  }
}

async function modifyIOSInfoPlistAsync(path, filename, templateSubstitutions) {
  await modifyIOSPropertyListAsync(path, filename, (config) => {
    if (templateSubstitutions.FABRIC_API_KEY) {
      config.Fabric = {
        APIKey: templateSubstitutions.FABRIC_API_KEY,
        Kits: [{
          KitInfo: {},
          KitName: 'Crashlytics',
        }],
      };
    }
    config.EXClientVersion = config.CFBundleVersion;
    return config;
  });
}

async function getTemplateSubstitutions() {
  try {
    return await new JsonFile(path.join(EXPONENT_DIR, '__internal__', 'keys.json')).readAsync();
  } catch (e) {
    // Don't have __internal__, use public keys
    return await new JsonFile(path.join(EXPONENT_DIR, 'template-files', 'keys.json')).readAsync();
  }
}

async function copyTemplateFilesAsync(platform, args) {
  let templateFilesPath = path.join(EXPONENT_DIR, 'template-files');
  let templatePaths = await new JsonFile(path.join(templateFilesPath, `${platform}-paths.json`)).readAsync();
  let templateSubstitutions = await getTemplateSubstitutions();

  let promises = [];
  _.forEach(templatePaths, (dest, source) => {
    promises.push(copyTemplateFileAsync(path.join(templateFilesPath, platform, source), path.join(EXPONENT_DIR, dest, source), templateSubstitutions));
  });

  if (platform === 'ios') {
    let infoPlistPath = args.infoPlistPath;
    await modifyIOSInfoPlistAsync(infoPlistPath, 'Info', templateSubstitutions);
    await renderPodfileAsync(
      path.join(templateFilesPath, platform, 'Podfile'),
      path.join(EXPONENT_DIR, 'ios', 'Podfile'),
      {
        TARGET_NAME: 'Exponent',
        REACT_NATIVE_PATH: templateSubstitutions.REACT_NATIVE_PATH,
      }
    );

    if (args.exponentViewPath) {
      let exponentViewPath = path.join(process.cwd(), args.exponentViewPath);
      await renderExponentViewPodspecAsync(
        path.join(templateFilesPath, platform, 'ExponentView.podspec'),
        path.join(exponentViewPath, 'ExponentView.podspec')
      );
      await renderPodfileAsync(
        path.join(templateFilesPath, platform, 'ExponentView-Podfile'),
        path.join(exponentViewPath, 'exponent-view-template', 'ios', 'Podfile'),
        {
          TARGET_NAME: 'exponent-view-template',
          EXPONENT_ROOT_PATH: '../..',
        }
      );
    }
  }

  await Promise.all(promises);
}

/**
 *  args:
 *    platform (ios|android)
 *    buildConstantsPath
 *  ios-only:
 *    infoPlistPath
 *    exponentViewPath (optional - if provided, generate files for exponent-view-template)
 */
export async function generateDynamicMacrosAsync(args) {
  try {
    let filepath = path.resolve(args.buildConstantsPath);
    let filename = path.basename(filepath);
    let platform = args.platform;

    let result = await Promise.all([
      generateSourceAsync(filename, platform),
      readExistingSourceAsync(filepath),
    ]);
    let source = result[0];
    let existingSource = result[1];

    if (source !== existingSource) {
      await fs.promise.writeFile(filepath, source, 'utf8');
    }

    await copyTemplateFilesAsync(platform, args);
  } catch (error) {
    console.error(`Uncaught ${error.stack}`);
    process.exit(1);
  }
}

export async function cleanupDynamicMacrosAsync(args) {
  try {
    let platform = args.platform;
    if (platform === 'ios') {
      let infoPlistPath = args.infoPlistPath;
      await cleanIOSPropertyListBackupAsync(infoPlistPath, 'Info', true);
    }
  } catch (error) {
    console.error(`Uncaught ${error.stack}`);
    process.exit(1);
  }
}

export async function runFabricIOSAsync(args) {
  let templateSubstitutions = await getTemplateSubstitutions();
  try {
    let configFile = await new JsonFile(path.join(EXPONENT_DIR, 'ios', 'private-shell-app-config.json')).readAsync();
    if (configFile && configFile.fabric && configFile.fabric.apiKey) {
      templateSubstitutions.FABRIC_API_KEY = configFile.fabric.apiKey;
    }

    if (configFile && configFile.fabric && configFile.fabric.buildSecret) {
      templateSubstitutions.FABRIC_API_SECRET = configFile.fabric.buildSecret;
    }
  } catch (e) {
    // don't have a config file, just use default keys
  }

  await spawnAsync(`/bin/sh`, [args.fabricPath, templateSubstitutions.FABRIC_API_KEY, templateSubstitutions.FABRIC_API_SECRET], {
    stdio: 'inherit',
    cwd: args.iosPath,
  });
}
