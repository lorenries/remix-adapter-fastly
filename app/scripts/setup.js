const path = require("path");
const fse = require("fs-extra");

setupRemix();

async function setupRemix() {
  let remixPkgJsonFile;

  try {
    remixPkgJsonFile = resolvePackageJsonFile("remix");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      console.error(
        `Missing the "remix" package. Please run \`npm install remix\` before \`remix setup\`.`
      );

      return;
    } else {
      throw error;
    }
  }

  const platformPkgJsonFile = resolvePackageJsonFile(`remix-adapter-fastly`);
  const serverPkgJsonFile = resolvePackageJsonFile(`@remix-run/server-runtime`);
  const clientPkgJsonFile = resolvePackageJsonFile(`@remix-run/react`);

  // Update remix/package.json dependencies
  const remixDeps = {};
  await assignDependency(remixDeps, platformPkgJsonFile);
  await assignDependency(remixDeps, serverPkgJsonFile);
  await assignDependency(remixDeps, clientPkgJsonFile);

  const remixPkgJson = await fse.readJSON(remixPkgJsonFile);
  // We can overwrite all dependencies at once because the remix package
  // doesn't actually have any dependencies.
  remixPkgJson.dependencies = remixDeps;

  await fse.writeJSON(remixPkgJsonFile, remixPkgJson, { spaces: 2 });

  // Copy magicExports directories to remix
  const remixPkgDir = path.dirname(remixPkgJsonFile);
  const platformExportsDir = path.resolve(
    platformPkgJsonFile,
    "..",
    "magicExports"
  );
  const serverExportsDir = path.resolve(
    serverPkgJsonFile,
    "..",
    "magicExports"
  );
  const clientExportsDir = path.resolve(
    clientPkgJsonFile,
    "..",
    "magicExports"
  );

  await Promise.all([
    fse.copy(platformExportsDir, remixPkgDir),
    fse.copy(serverExportsDir, remixPkgDir),
    fse.copy(clientExportsDir, remixPkgDir),
  ]);
}

function resolvePackageJsonFile(packageName) {
  return require.resolve(path.join(packageName, "package.json"));
}

async function assignDependency(deps, pkgJsonFile) {
  const pkgJson = await fse.readJSON(pkgJsonFile);
  deps[pkgJson.name] = pkgJson.version;
}
