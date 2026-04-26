import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(directory, visit) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      walk(fullPath, visit);
    } else {
      visit(fullPath);
    }
  }
}

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  const resourcesPath = join(
    appOutDir,
    electronPlatformName === 'darwin'
      ? `${context.packager.appInfo.productName}.app/Contents/Resources`
      : 'resources'
  );

  const requiredFolders = ['Assets', 'inference_server', 'comfyui_backend', 'skills'];
  if (electronPlatformName === 'win32') {
    requiredFolders.push('python_embeded');
  }

  const missing = requiredFolders.filter(
    (folder) => !existsSync(join(resourcesPath, folder))
  );
  if (missing.length > 0) {
    throw new Error(
      `electron-builder afterPack: missing required resources [${missing.join(', ')}] in ${resourcesPath}`
    );
  }

  const pythonRoot = join(resourcesPath, 'python_embeded');
  if (existsSync(pythonRoot)) {
    const pythonExe = join(
      pythonRoot,
      electronPlatformName === 'win32' ? 'python.exe' : 'python'
    );
    if (!existsSync(pythonExe)) {
      throw new Error(
        `electron-builder afterPack: python runtime missing executable at ${pythonExe}`
      );
    }
  }

  const leakedPdbs = [];
  walk(appOutDir, (file) => {
    if (file.toLowerCase().endsWith('.pdb')) {
      leakedPdbs.push(file);
    }
  });
  if (leakedPdbs.length > 0) {
    throw new Error(
      `electron-builder afterPack: ${leakedPdbs.length} debug symbol file(s) leaked into the package, e.g. ${leakedPdbs[0]}`
    );
  }

  const totalSize = computeDirectorySize(appOutDir);
  const totalGiB = totalSize / 1024 / 1024 / 1024;
  console.log(
    `[afterPack] resources verified at ${resourcesPath} — package size ~${totalGiB.toFixed(2)} GiB`
  );
}

function computeDirectorySize(directory) {
  let total = 0;
  walk(directory, (file) => {
    try {
      total += statSync(file).size;
    } catch {
      // ignore unreadable file
    }
  });
  return total;
}
