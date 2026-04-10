// Module de résolution des chemins de ressources selon l'environnement
const path = require('path');

// Retourne le répertoire racine des ressources selon le mode packagé ou développement
function resourceRootDir(app) {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..', '..', '..');
}

// Construit un chemin absolu vers une ressource en combinant les segments fournis
function resourcePath(app, ...segments) {
  return path.join(resourceRootDir(app), ...segments);
}

// Retourne le répertoire racine des ressources de l'application
function resourceDir(app) {
  return resourceRootDir(app);
}

module.exports = {
  resourceRootDir,
  resourcePath,
  resourceDir,
};
