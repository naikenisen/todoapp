const path = require('path');

function resourceRootDir(app) {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..', '..', '..');
}

function resourcePath(app, ...segments) {
  return path.join(resourceRootDir(app), ...segments);
}

function resourceDir(app) {
  return resourceRootDir(app);
}

module.exports = {
  resourceRootDir,
  resourcePath,
  resourceDir,
};
